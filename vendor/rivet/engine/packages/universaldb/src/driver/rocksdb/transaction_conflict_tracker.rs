use std::{
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use tokio::sync::Mutex;

use crate::options::ConflictRangeType;

// Transactions cannot live longer than 5 seconds so we don't need to store transaction conflicts longer than
// that
const TXN_CONFLICT_TTL: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct PreviousTransaction {
	insert_instant: Instant,
	start_version: u64,
	commit_version: u64,
	conflict_ranges: Vec<(Vec<u8>, Vec<u8>, ConflictRangeType)>,
}

#[derive(Debug, Default)]
struct ConflictTrackerState {
	txns: Vec<PreviousTransaction>,
	conflict_range_count: usize,
}

#[derive(Debug, Default)]
pub struct ConflictCheckStats {
	pub lock_wait_duration: Duration,
	pub prune_duration: Duration,
	pub scan_duration: Duration,
	pub previous_txn_count: usize,
	pub previous_conflict_range_count: usize,
	pub pruned_txn_count: usize,
	pub version_overlap_txn_count: usize,
	pub version_overlap_conflict_range_count: usize,
	pub current_read_range_count: usize,
	pub current_write_range_count: usize,
	pub current_empty_range_count: usize,
	pub current_point_range_count: usize,
	pub current_broad_range_count: usize,
	pub range_pair_count: usize,
	pub same_type_range_pair_count: usize,
	pub opposite_type_range_pair_count: usize,
	pub overlap_range_pair_count: usize,
	pub conflicting_range_pair_count: usize,
}

#[derive(Debug)]
pub struct ConflictCheckOutcome {
	pub has_conflict: bool,
	pub stats: ConflictCheckStats,
}

#[derive(Clone)]
pub struct TransactionConflictTracker {
	// NOTE: We use a mutex because we need to lock reads across all active txns. This could be optimized to
	// only lock txns that have overlapping ranges with the currently checking one, but its a small
	// optimization because most txns are going to be very recent and this only stores the last 10 seconds of
	// txns.
	txns: Arc<Mutex<ConflictTrackerState>>,
	global_version: Arc<AtomicU64>,
}

impl TransactionConflictTracker {
	pub fn new() -> Self {
		TransactionConflictTracker {
			txns: Arc::new(Mutex::new(ConflictTrackerState::default())),
			global_version: Arc::new(AtomicU64::new(0)),
		}
	}

	/// Each number returned is unique.
	pub fn next_global_version(&self) -> u64 {
		self.global_version.fetch_add(1, Ordering::SeqCst)
	}

	pub async fn check_and_insert_with_stats(
		&self,
		txn1_start_version: u64,
		txn1_conflict_ranges: Vec<(Vec<u8>, Vec<u8>, ConflictRangeType)>,
	) -> ConflictCheckOutcome {
		let mut stats = summarize_current_ranges(&txn1_conflict_ranges);
		if txn1_conflict_ranges.is_empty() {
			return ConflictCheckOutcome {
				has_conflict: false,
				stats,
			};
		}

		let lock_wait_started = Instant::now();
		let mut state = self.txns.lock().await;
		stats.lock_wait_duration = lock_wait_started.elapsed();

		let txn1_commit_version = self.next_global_version();

		// Prune old entries
		let txn_count_before_prune = state.txns.len();
		let prune_started = Instant::now();
		let mut pruned_conflict_range_count = 0;
		state.txns.retain(|txn| {
			let keep = txn.insert_instant.elapsed() < TXN_CONFLICT_TTL;
			if !keep {
				pruned_conflict_range_count += txn.conflict_ranges.len();
			}
			keep
		});
		state.conflict_range_count = state
			.conflict_range_count
			.saturating_sub(pruned_conflict_range_count);
		stats.prune_duration = prune_started.elapsed();
		stats.pruned_txn_count = txn_count_before_prune.saturating_sub(state.txns.len());
		stats.previous_txn_count = state.txns.len();
		stats.previous_conflict_range_count = state.conflict_range_count;

		let scan_started = Instant::now();
		for txn2 in &state.txns {
			// Check txn versions overlap (intersection or encapsulation)
			if txn1_start_version < txn2.commit_version && txn2.start_version < txn1_commit_version
			{
				stats.version_overlap_txn_count += 1;
				stats.version_overlap_conflict_range_count += txn2.conflict_ranges.len();

				for (cr1_start, cr1_end, cr1_type) in &txn1_conflict_ranges {
					for (cr2_start, cr2_end, cr2_type) in &txn2.conflict_ranges {
						stats.range_pair_count += 1;
						if cr1_type == cr2_type {
							stats.same_type_range_pair_count += 1;
						} else {
							stats.opposite_type_range_pair_count += 1;
						}

						// Check conflict ranges overlap
						let ranges_overlap = cr1_start < cr2_end && cr2_start < cr1_end;
						if ranges_overlap {
							stats.overlap_range_pair_count += 1;
						}

						if ranges_overlap && cr1_type != cr2_type {
							stats.conflicting_range_pair_count += 1;
							stats.scan_duration = scan_started.elapsed();

							tracing::debug!(
								cr1_start=%hex::encode(cr1_start),
								cr1_end=%hex::encode(cr1_end),
								?cr1_type,
								cr2_start=%hex::encode(cr2_start),
								cr2_end=%hex::encode(cr2_end),
								?cr2_type,
								txn1_start_version,
								txn1_commit_version,
								txn2_start_version = txn2.start_version,
								txn2_commit_version = txn2.commit_version,
								"transaction conflict detected"
							);
							return ConflictCheckOutcome {
								has_conflict: true,
								stats,
							};
						}
					}
				}
			}
		}
		stats.scan_duration = scan_started.elapsed();

		// If no conflicts were detected, save txn data
		state.conflict_range_count += txn1_conflict_ranges.len();
		state.txns.push(PreviousTransaction {
			insert_instant: Instant::now(),
			start_version: txn1_start_version,
			commit_version: txn1_commit_version,
			conflict_ranges: txn1_conflict_ranges,
		});

		ConflictCheckOutcome {
			has_conflict: false,
			stats,
		}
	}

	pub async fn remove(&self, txn_start_version: u64) {
		let mut state = self.txns.lock().await;

		if let Some(i) = state
			.txns
			.iter()
			.enumerate()
			.find_map(|(i, txn)| (txn.start_version == txn_start_version).then_some(i))
		{
			let txn = state.txns.remove(i);
			state.conflict_range_count = state
				.conflict_range_count
				.saturating_sub(txn.conflict_ranges.len());
		}
	}
}

fn summarize_current_ranges(
	conflict_ranges: &[(Vec<u8>, Vec<u8>, ConflictRangeType)],
) -> ConflictCheckStats {
	let mut stats = ConflictCheckStats::default();

	for (begin, end, conflict_type) in conflict_ranges {
		match conflict_type {
			ConflictRangeType::Read => stats.current_read_range_count += 1,
			ConflictRangeType::Write => stats.current_write_range_count += 1,
		}

		if begin >= end {
			stats.current_empty_range_count += 1;
		} else if is_point_range(begin, end) {
			stats.current_point_range_count += 1;
		} else {
			stats.current_broad_range_count += 1;
		}
	}

	stats
}

fn is_point_range(begin: &[u8], end: &[u8]) -> bool {
	end.len() == begin.len() + 1 && end.starts_with(begin) && end[begin.len()] == 0
}

#[cfg(test)]
mod tests {
	use super::*;

	fn range(
		begin: &[u8],
		end: &[u8],
		conflict_type: ConflictRangeType,
	) -> (Vec<u8>, Vec<u8>, ConflictRangeType) {
		(begin.to_vec(), end.to_vec(), conflict_type)
	}

	fn point_range(
		key: &[u8],
		conflict_type: ConflictRangeType,
	) -> (Vec<u8>, Vec<u8>, ConflictRangeType) {
		let mut end = key.to_vec();
		end.push(0);
		(key.to_vec(), end, conflict_type)
	}

	#[test]
	fn summarizes_current_range_shape() {
		let stats = summarize_current_ranges(&[
			range(b"a", b"z", ConflictRangeType::Read),
			point_range(b"k", ConflictRangeType::Write),
			range(b"x", b"x", ConflictRangeType::Read),
		]);

		assert_eq!(stats.current_read_range_count, 2);
		assert_eq!(stats.current_write_range_count, 1);
		assert_eq!(stats.current_broad_range_count, 1);
		assert_eq!(stats.current_point_range_count, 1);
		assert_eq!(stats.current_empty_range_count, 1);
	}

	#[tokio::test]
	async fn reports_conflict_scan_shape() {
		let tracker = TransactionConflictTracker::new();
		let start_version = tracker.next_global_version();

		let first = tracker
			.check_and_insert_with_stats(
				start_version,
				vec![point_range(b"a", ConflictRangeType::Read)],
			)
			.await;
		assert!(!first.has_conflict);
		assert_eq!(first.stats.previous_txn_count, 0);
		assert_eq!(first.stats.current_point_range_count, 1);

		let second = tracker
			.check_and_insert_with_stats(
				start_version,
				vec![point_range(b"a", ConflictRangeType::Write)],
			)
			.await;
		assert!(second.has_conflict);
		assert_eq!(second.stats.previous_txn_count, 1);
		assert_eq!(second.stats.previous_conflict_range_count, 1);
		assert_eq!(second.stats.version_overlap_txn_count, 1);
		assert_eq!(second.stats.version_overlap_conflict_range_count, 1);
		assert_eq!(second.stats.range_pair_count, 1);
		assert_eq!(second.stats.opposite_type_range_pair_count, 1);
		assert_eq!(second.stats.overlap_range_pair_count, 1);
		assert_eq!(second.stats.conflicting_range_pair_count, 1);
	}

	#[tokio::test]
	async fn skips_empty_conflict_range_transactions() {
		let tracker = TransactionConflictTracker::new();
		let empty_start_version = tracker.next_global_version();

		let empty = tracker
			.check_and_insert_with_stats(empty_start_version, Vec::new())
			.await;
		assert!(!empty.has_conflict);
		assert_eq!(empty.stats.previous_txn_count, 0);
		assert_eq!(empty.stats.previous_conflict_range_count, 0);

		let write_start_version = tracker.next_global_version();
		let write = tracker
			.check_and_insert_with_stats(
				write_start_version,
				vec![point_range(b"a", ConflictRangeType::Write)],
			)
			.await;
		assert!(!write.has_conflict);
		assert_eq!(write.stats.previous_txn_count, 0);
		assert_eq!(write.stats.previous_conflict_range_count, 0);
	}

	#[tokio::test]
	async fn tracks_previous_conflict_range_count_incrementally() {
		let tracker = TransactionConflictTracker::new();

		let first_start_version = tracker.next_global_version();
		let first = tracker
			.check_and_insert_with_stats(
				first_start_version,
				vec![
					point_range(b"a", ConflictRangeType::Read),
					point_range(b"b", ConflictRangeType::Read),
				],
			)
			.await;
		assert!(!first.has_conflict);
		assert_eq!(first.stats.previous_conflict_range_count, 0);

		let second_start_version = tracker.next_global_version();
		let second = tracker
			.check_and_insert_with_stats(
				second_start_version,
				vec![point_range(b"z", ConflictRangeType::Write)],
			)
			.await;
		assert!(!second.has_conflict);
		assert_eq!(second.stats.previous_txn_count, 1);
		assert_eq!(second.stats.previous_conflict_range_count, 2);

		tracker.remove(first_start_version).await;

		let third_start_version = tracker.next_global_version();
		let third = tracker
			.check_and_insert_with_stats(
				third_start_version,
				vec![point_range(b"y", ConflictRangeType::Write)],
			)
			.await;
		assert!(!third.has_conflict);
		assert_eq!(third.stats.previous_txn_count, 1);
		assert_eq!(third.stats.previous_conflict_range_count, 1);
	}
}
