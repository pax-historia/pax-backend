use lazy_static::lazy_static;
use rivet_metrics::{REGISTRY, prometheus::*};

lazy_static! {
	pub static ref ROUTE_TOTAL: IntGaugeVec = register_int_gauge_vec_with_registry!(
		"guard_route_total",
		"Total number of routing results handled.",
		&["router"],
		*REGISTRY
	)
	.unwrap();
	pub static ref ROUTING_DIRECTORY_LOOKUP_TOTAL: IntCounterVec =
		register_int_counter_vec_with_registry!(
			"guard_routing_directory_lookup_total",
			"Routing-directory lookup decisions for actor gateway routing.",
			&["result", "target"],
			*REGISTRY
		)
		.unwrap();
}
