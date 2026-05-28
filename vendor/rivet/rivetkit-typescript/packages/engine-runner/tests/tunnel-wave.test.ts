import * as protocol from "@rivetkit/engine-runner-protocol";
import { describe, expect, it } from "vitest";
import {
	aggregateGatewayPressures,
	buildToServerTickWaves,
	decodeToClientTickWave,
	partitionToServerTunnelMessagesByPressure,
	pressureFromTunnelControl,
	requestPressureKey,
	toServerTunnelMessagePressureCost,
} from "../src/tunnel-wave";
import { idToStr } from "../src/utils";

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

const GATEWAY_A = exactArrayBuffer(new Uint8Array([1, 1, 1, 1]));
const GATEWAY_B = exactArrayBuffer(new Uint8Array([2, 2, 2, 2]));
const REQ_A = exactArrayBuffer(new Uint8Array([10, 0, 0, 0]));
const REQ_B = exactArrayBuffer(new Uint8Array([20, 0, 0, 0]));

function bytes(data: string): ArrayBuffer {
	return exactArrayBuffer(new TextEncoder().encode(data));
}

function serverWsMessage(
	gatewayId: ArrayBuffer,
	requestId: ArrayBuffer,
	messageIndex: number,
	data: string,
): protocol.ToServerTunnelMessage {
	return {
		messageId: {
			gatewayId,
			requestId,
			messageIndex,
		},
		messageKind: {
			tag: "ToServerWebSocketMessage",
			val: {
				data: bytes(data),
				binary: true,
			},
		},
	};
}

function serverHttpChunk(
	gatewayId: ArrayBuffer,
	requestId: ArrayBuffer,
	messageIndex: number,
	body: string,
): protocol.ToServerTunnelMessage {
	return {
		messageId: {
			gatewayId,
			requestId,
			messageIndex,
		},
		messageKind: {
			tag: "ToServerResponseChunk",
			val: {
				body: bytes(body),
				finish: false,
			},
		},
	};
}

function clientWsMessageKind(data: string): protocol.ToClientTunnelMessageKind {
	return {
		tag: "ToClientWebSocketMessage",
		val: {
			data: bytes(data),
			binary: true,
		},
	};
}

describe("buildToServerTickWaves", () => {
	it("groups runner tunnel messages by gateway and advances epochs", () => {
		const epochs = new Map<string, bigint>();
		const a1 = serverWsMessage(GATEWAY_A, REQ_A, 7, "a1");
		const b1 = serverWsMessage(GATEWAY_B, REQ_A, 3, "b1");
		const a2 = serverHttpChunk(GATEWAY_A, REQ_B, 9, "a2");

		const waves = buildToServerTickWaves([a1, b1, a2], epochs);

		expect(waves).toHaveLength(2);
		expect(waves[0].wave.gatewayId).toBe(GATEWAY_A);
		expect(waves[0].wave.epoch).toBe(1n);
		expect(waves[0].wave.frames).toHaveLength(2);
		expect(waves[0].wave.frames[0].sequenceRange).toEqual({
			first: 7n,
			last: 7n,
		});
		expect(waves[0].wave.frames[0].messageKind).toBe(
			protocol.TunnelFrameKind.WebSocket,
		);
		expect(
			protocol.decodeToServerTunnelMessageKind(
				new Uint8Array(waves[0].wave.frames[0].bytes),
			),
		).toEqual(a1.messageKind);
		expect(waves[0].wave.frames[1].requestId).toBe(REQ_B);
		expect(waves[0].wave.frames[1].sequenceRange).toEqual({
			first: 9n,
			last: 9n,
		});
		expect(waves[0].wave.frames[1].messageKind).toBe(
			protocol.TunnelFrameKind.Http,
		);
		expect(
			protocol.decodeToServerTunnelMessageKind(
				new Uint8Array(waves[0].wave.frames[1].bytes),
			),
		).toEqual(a2.messageKind);
		expect(waves[1].wave.gatewayId).toBe(GATEWAY_B);
		expect(waves[1].wave.epoch).toBe(1n);
		expect(waves[1].wave.frames[0].sequenceRange).toEqual({
			first: 3n,
			last: 3n,
		});
		expect(
			protocol.decodeToServerTunnelMessageKind(
				new Uint8Array(waves[1].wave.frames[0].bytes),
			),
		).toEqual(b1.messageKind);

		const next = buildToServerTickWaves(
			[serverWsMessage(GATEWAY_A, REQ_A, 10, "a3")],
			epochs,
		);
		expect(next[0].wave.epoch).toBe(2n);
	});
});

describe("partitionToServerTunnelMessagesByPressure", () => {
	it("blocks credit-exhausted gateways without blocking other gateways", () => {
		const a1 = serverWsMessage(GATEWAY_A, REQ_A, 7, "a1");
		const b1 = serverWsMessage(GATEWAY_B, REQ_A, 3, "b1");
		const a2 = serverHttpChunk(GATEWAY_A, REQ_B, 9, "a2");

		const partition = partitionToServerTunnelMessagesByPressure(
			[a1, b1, a2],
			new Map([
				[
					idToStr(GATEWAY_A),
					{
						credit: 0,
						queueDepth: 128,
						oldestAgeMs: 250n,
					},
				],
			]),
		);

		expect(partition.ready).toEqual([b1]);
		expect(partition.blocked).toEqual([a1, a2]);
	});

	it("blocks request-scoped pressure without blocking sibling requests", () => {
		const a1 = serverWsMessage(GATEWAY_A, REQ_A, 7, "a1");
		const a2 = serverHttpChunk(GATEWAY_A, REQ_B, 9, "a2");
		const b1 = serverWsMessage(GATEWAY_B, REQ_A, 3, "b1");

		const partition = partitionToServerTunnelMessagesByPressure(
			[a1, a2, b1],
			new Map(),
			new Map([
				[
					requestPressureKey(GATEWAY_A, REQ_A),
					{
						credit: 0,
						queueDepth: 1,
						oldestAgeMs: 50n,
					},
				],
			]),
		);

		expect(partition.ready).toEqual([a2, b1]);
		expect(partition.blocked).toEqual([a1]);
	});

	it("spends credit per encoded tunnel message", () => {
		const a1 = serverWsMessage(GATEWAY_A, REQ_A, 7, "a1");
		const a2 = serverHttpChunk(GATEWAY_A, REQ_B, 9, "a2");
		const b1 = serverWsMessage(GATEWAY_B, REQ_A, 3, "b1");
		const pressureByGateway = new Map([
			[
				idToStr(GATEWAY_A),
				{
					credit: toServerTunnelMessagePressureCost(a1),
					queueDepth: 4,
					oldestAgeMs: null,
				},
			],
		]);

		const partition = partitionToServerTunnelMessagesByPressure(
			[a1, a2, b1],
			pressureByGateway,
		);

		expect(partition.ready).toEqual([a1, b1]);
		expect(partition.blocked).toEqual([a2]);
		expect(pressureByGateway.get(idToStr(GATEWAY_A))?.credit).toBe(0);
	});

	it("preserves remaining byte credit after ready messages", () => {
		const a1 = serverWsMessage(GATEWAY_A, REQ_A, 7, "a1");
		const a2 = serverHttpChunk(GATEWAY_A, REQ_B, 9, "a2");
		const remainingCredit = 3;
		const pressureByGateway = new Map([
			[
				idToStr(GATEWAY_A),
				{
					credit:
						toServerTunnelMessagePressureCost(a1) +
						toServerTunnelMessagePressureCost(a2) +
						remainingCredit,
					queueDepth: 4,
					oldestAgeMs: null,
				},
			],
		]);

		const partition = partitionToServerTunnelMessagesByPressure(
			[a1, a2],
			pressureByGateway,
		);

		expect(partition.ready).toEqual([a1, a2]);
		expect(partition.blocked).toEqual([]);
		expect(pressureByGateway.get(idToStr(GATEWAY_A))?.credit).toBe(
			remainingCredit,
		);
	});
});

describe("aggregateGatewayPressures", () => {
	it("returns null when no gateways are pressured", () => {
		expect(aggregateGatewayPressures([])).toBeNull();
	});

	it("uses minimum credit, summed queue depth, and oldest age", () => {
		expect(
			aggregateGatewayPressures([
				{ credit: 50, queueDepth: 2, oldestAgeMs: 10n },
				{ credit: 5, queueDepth: 7, oldestAgeMs: 25n },
				{ credit: 20, queueDepth: 1, oldestAgeMs: null },
			]),
		).toEqual({
			credit: 5,
			queueDepth: 10,
			oldestAgeMs: 25n,
		});
	});

	it("caps aggregate queue depth to u32", () => {
		expect(
			aggregateGatewayPressures([
				{ credit: 1, queueDepth: 0xffffffff, oldestAgeMs: null },
				{ credit: 2, queueDepth: 1, oldestAgeMs: null },
			])?.queueDepth,
		).toBe(0xffffffff);
	});
});

describe("pressureFromTunnelControl", () => {
	it("extracts pressure controls", () => {
		const pressure = {
			gatewayId: GATEWAY_A,
			requestId: null,
			pressure: {
				credit: 0,
				queueDepth: 8,
				oldestAgeMs: 10n,
			},
		};

		expect(
			pressureFromTunnelControl({
				tag: "TunnelPressure",
				val: pressure,
			}),
		).toBe(pressure);
	});

	it("ignores non-pressure controls", () => {
		expect(
			pressureFromTunnelControl({
				tag: "TunnelAck",
				val: {
					gatewayId: GATEWAY_A,
					requestId: REQ_A,
					lastAckedSeq: 7n,
				},
			}),
		).toBeUndefined();
	});
});

describe("decodeToClientTickWave", () => {
	it("decodes single-message client frames", () => {
		const messageKind = clientWsMessageKind("hello");
		const decoded = decodeToClientTickWave({
			epoch: 1n,
			gatewayId: GATEWAY_A,
			frames: [
				{
					requestId: REQ_A,
					sequenceRange: {
						first: 4n,
						last: 4n,
					},
					messageKind: protocol.TunnelFrameKind.WebSocket,
					bytes: exactArrayBuffer(
						protocol.encodeToClientTunnelMessageKind(messageKind),
					),
				},
			],
			backpressure: null,
		});

		expect(decoded).toEqual([
			{
				messageId: {
					gatewayId: GATEWAY_A,
					requestId: REQ_A,
					messageIndex: 4,
				},
				messageKind,
			},
		]);
	});

	it("rejects v8-only sequence ranges in the legacy runner adapter", () => {
		const messageKind = clientWsMessageKind("hello");

		expect(() =>
			decodeToClientTickWave({
				epoch: 1n,
				gatewayId: GATEWAY_A,
				frames: [
					{
						requestId: REQ_A,
						sequenceRange: {
							first: 4n,
							last: 5n,
						},
						messageKind: protocol.TunnelFrameKind.WebSocket,
						bytes: exactArrayBuffer(
							protocol.encodeToClientTunnelMessageKind(
								messageKind,
							),
						),
					},
				],
				backpressure: null,
			}),
		).toThrow(/multi-message/);
	});

	it("rejects frame kind mismatches", () => {
		const messageKind = clientWsMessageKind("hello");

		expect(() =>
			decodeToClientTickWave({
				epoch: 1n,
				gatewayId: GATEWAY_A,
				frames: [
					{
						requestId: REQ_A,
						sequenceRange: {
							first: 4n,
							last: 4n,
						},
						messageKind: protocol.TunnelFrameKind.Http,
						bytes: exactArrayBuffer(
							protocol.encodeToClientTunnelMessageKind(
								messageKind,
							),
						),
					},
				],
				backpressure: null,
			}),
		).toThrow(/frame kind mismatch/);
	});

	it("rejects sequences outside the legacy message index range", () => {
		const messageKind = clientWsMessageKind("hello");

		expect(() =>
			decodeToClientTickWave({
				epoch: 1n,
				gatewayId: GATEWAY_A,
				frames: [
					{
						requestId: REQ_A,
						sequenceRange: {
							first: 0x1_0000n,
							last: 0x1_0000n,
						},
						messageKind: protocol.TunnelFrameKind.WebSocket,
						bytes: exactArrayBuffer(
							protocol.encodeToClientTunnelMessageKind(
								messageKind,
							),
						),
					},
				],
				backpressure: null,
			}),
		).toThrow(/exceeds runner message index range/);
	});
});
