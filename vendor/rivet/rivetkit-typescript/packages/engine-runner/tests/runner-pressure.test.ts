import * as protocol from "@rivetkit/engine-runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Runner,
	type RunnerConfig,
	type TunnelPressureUpdate,
} from "../src/mod";
import {
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

const originalWebSocket = globalThis.WebSocket;

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.OPEN;
	readonly sent: unknown[] = [];
	readonly listeners = new Map<string, Array<(event: any) => unknown>>();

	constructor(
		readonly url: string,
		readonly protocols: string[],
	) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (event: any) => unknown) {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	send(data: unknown) {
		this.sent.push(data);
	}

	close(code = 1000, reason = "closed") {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		void this.dispatch("close", { code, reason });
	}

	async dispatch(type: string, event: any) {
		for (const listener of this.listeners.get(type) ?? []) {
			await listener(event);
		}
	}
}

function buildRunnerConfig(
	onTunnelPressure: (update: TunnelPressureUpdate) => void,
): RunnerConfig {
	return {
		version: 1,
		endpoint: "http://127.0.0.1:6420",
		namespace: "default",
		totalSlots: 1,
		runnerName: "runner-pressure-test",
		prepopulateActorNames: {},
		onConnected: () => {},
		onDisconnected: () => {},
		onShutdown: () => {},
		onTunnelPressure,
		fetch: async () => new Response("ok"),
		websocket: async () => {},
		hibernatableWebSocket: {
			canHibernate: () => false,
		},
		onActorStart: async () => {},
		onActorStop: async () => {},
		noAutoShutdown: true,
	};
}

function encodeClientMessage(message: protocol.ToClient): Buffer {
	return Buffer.from(protocol.encodeToClient(message));
}

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

function decodeSentToServer(data: unknown): protocol.ToServer {
	expect(data).toBeInstanceOf(Uint8Array);
	return protocol.decodeToServer(data as Uint8Array);
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function dispatchClientMessage(
	ws: FakeWebSocket,
	message: protocol.ToClient,
) {
	await ws.dispatch("message", {
		data: encodeClientMessage(message),
	});
}

describe.sequential("Runner tunnel pressure notifications", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		globalThis.WebSocket =
			FakeWebSocket as unknown as typeof globalThis.WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
	});

	it("publishes deduplicated aggregate pressure snapshots", async () => {
		const updates: TunnelPressureUpdate[] = [];
		const runner = new Runner(buildRunnerConfig((update) => {
			updates.push(update);
		}));
		await runner.start();
		const ws = FakeWebSocket.instances[0];
		expect(ws).toBeDefined();

		try {
			await dispatchClientMessage(ws, {
				tag: "ToClientTickWave",
				val: {
					wave: {
						epoch: 1n,
						gatewayId: GATEWAY_A,
						frames: [],
						backpressure: {
							credit: 100,
							queueDepth: 2,
							oldestAgeMs: 10n,
						},
					},
				},
			});
			await dispatchClientMessage(ws, {
				tag: "ToClientTickWave",
				val: {
					wave: {
						epoch: 2n,
						gatewayId: GATEWAY_A,
						frames: [],
						backpressure: {
							credit: 100,
							queueDepth: 2,
							oldestAgeMs: 10n,
						},
					},
				},
			});
			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_B,
							requestId: null,
							pressure: {
								credit: 5,
								queueDepth: 7,
								oldestAgeMs: 25n,
							},
						},
					},
				},
			});
			await dispatchClientMessage(ws, {
				tag: "ToClientTickWave",
				val: {
					wave: {
						epoch: 3n,
						gatewayId: GATEWAY_A,
						frames: [],
						backpressure: null,
					},
				},
			});

			expect(updates).toHaveLength(3);
			expect(updates[0].pressure).toEqual({
				credit: 100,
				queueDepth: 2,
				oldestAgeMs: 10n,
			});
			expect([...updates[0].gateways.keys()]).toEqual([
				idToStr(GATEWAY_A),
			]);
			expect(updates[1].pressure).toEqual({
				credit: 5,
				queueDepth: 9,
				oldestAgeMs: 25n,
			});
			expect([...updates[1].gateways.keys()]).toEqual([
				idToStr(GATEWAY_A),
				idToStr(GATEWAY_B),
			]);
			expect(updates[2].pressure).toEqual({
				credit: 5,
				queueDepth: 7,
				oldestAgeMs: 25n,
			});
			expect([...updates[2].gateways.keys()]).toEqual([
				idToStr(GATEWAY_B),
			]);
		} finally {
			await runner.shutdown(true, false);
		}
	});

	it("pauses tunnel sends while gateway credit is zero and releases on fresh credit", async () => {
		const runner = new Runner(buildRunnerConfig(() => {}));
		await runner.start();
		const ws = FakeWebSocket.instances[0];
		expect(ws).toBeDefined();

		try {
			ws.sent.length = 0;
			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_A,
							requestId: null,
							pressure: {
								credit: 0,
								queueDepth: 128,
								oldestAgeMs: 250n,
							},
						},
					},
				},
			});

			const blocked = serverWsMessage(GATEWAY_A, REQ_A, 7, "blocked");
			runner.__sendToServer({
				tag: "ToServerTunnelMessage",
				val: blocked,
			});
			await flushMicrotasks();

			expect(ws.sent).toHaveLength(0);

			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_A,
							requestId: null,
							pressure: {
								credit:
									toServerTunnelMessagePressureCost(blocked),
								queueDepth: 0,
								oldestAgeMs: null,
							},
						},
					},
				},
			});
			await flushMicrotasks();

			expect(ws.sent).toHaveLength(1);
			const sent = decodeSentToServer(ws.sent[0]);
			expect(sent.tag).toBe("ToServerTickWave");
			if (sent.tag !== "ToServerTickWave") return;
			expect(idToStr(sent.val.wave.gatewayId)).toBe(idToStr(GATEWAY_A));
			expect(sent.val.wave.frames).toHaveLength(1);
			expect(idToStr(sent.val.wave.frames[0]!.requestId)).toBe(
				idToStr(REQ_A),
			);
			expect(sent.val.wave.frames[0]?.sequenceRange).toEqual({
				first: 7n,
				last: 7n,
			});
		} finally {
			await runner.shutdown(true, false);
		}
	});

	it("publishes request-scoped pressure snapshots from controls", async () => {
		const updates: TunnelPressureUpdate[] = [];
		const runner = new Runner(buildRunnerConfig((update) => {
			updates.push(update);
		}));
		await runner.start();
		const ws = FakeWebSocket.instances[0];
		expect(ws).toBeDefined();

		try {
			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_A,
							requestId: REQ_A,
							pressure: {
								credit: 0,
								queueDepth: 3,
								oldestAgeMs: 75n,
							},
						},
					},
				},
			});

			expect(updates).toHaveLength(1);
			expect(updates[0]?.pressure).toEqual({
				credit: 0,
				queueDepth: 3,
				oldestAgeMs: 75n,
			});
			expect([...updates[0]!.gateways.keys()]).toEqual([]);
			expect([...(updates[0]!.requests?.entries() ?? [])]).toEqual([
				[
					requestPressureKey(GATEWAY_A, REQ_A),
					{
						credit: 0,
						queueDepth: 3,
						oldestAgeMs: 75n,
					},
				],
			]);

			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_A,
							requestId: REQ_A,
							pressure: {
								credit: 64,
								queueDepth: 0,
								oldestAgeMs: null,
							},
						},
					},
				},
			});

			expect(updates).toHaveLength(2);
			expect(updates[1]?.pressure).toEqual({
				credit: 64,
				queueDepth: 0,
				oldestAgeMs: null,
			});
			expect([...(updates[1]!.requests?.entries() ?? [])]).toEqual([
				[
					requestPressureKey(GATEWAY_A, REQ_A),
					{
						credit: 64,
						queueDepth: 0,
						oldestAgeMs: null,
					},
				],
			]);
		} finally {
			await runner.shutdown(true, false);
		}
	});

	it("pauses only the pressured request when request-scoped credit is zero", async () => {
		const runner = new Runner(buildRunnerConfig(() => {}));
		await runner.start();
		const ws = FakeWebSocket.instances[0];
		expect(ws).toBeDefined();

		try {
			ws.sent.length = 0;
			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_A,
							requestId: REQ_A,
							pressure: {
								credit: 0,
								queueDepth: 1,
								oldestAgeMs: 50n,
							},
						},
					},
				},
			});

			const blocked = serverWsMessage(GATEWAY_A, REQ_A, 11, "blocked");
			const ready = serverWsMessage(GATEWAY_A, REQ_B, 12, "ready");
			runner.__sendToServer({
				tag: "ToServerTunnelMessage",
				val: blocked,
			});
			runner.__sendToServer({
				tag: "ToServerTunnelMessage",
				val: ready,
			});
			await flushMicrotasks();

			expect(ws.sent).toHaveLength(1);
			const first = decodeSentToServer(ws.sent[0]);
			expect(first.tag).toBe("ToServerTickWave");
			if (first.tag !== "ToServerTickWave") return;
			expect(first.val.wave.frames).toHaveLength(1);
			expect(idToStr(first.val.wave.frames[0]!.requestId)).toBe(
				idToStr(REQ_B),
			);
			expect(first.val.wave.frames[0]?.sequenceRange).toEqual({
				first: 12n,
				last: 12n,
			});

			await dispatchClientMessage(ws, {
				tag: "ToClientTunnelControl",
				val: {
					control: {
						tag: "TunnelPressure",
						val: {
							gatewayId: GATEWAY_A,
							requestId: REQ_A,
							pressure: {
								credit:
									toServerTunnelMessagePressureCost(blocked),
								queueDepth: 0,
								oldestAgeMs: null,
							},
						},
					},
				},
			});
			await flushMicrotasks();

			expect(ws.sent).toHaveLength(2);
			const second = decodeSentToServer(ws.sent[1]);
			expect(second.tag).toBe("ToServerTickWave");
			if (second.tag !== "ToServerTickWave") return;
			expect(second.val.wave.frames).toHaveLength(1);
			expect(idToStr(second.val.wave.frames[0]!.requestId)).toBe(
				idToStr(REQ_A),
			);
			expect(second.val.wave.frames[0]?.sequenceRange).toEqual({
				first: 11n,
				last: 11n,
			});
		} finally {
			await runner.shutdown(true, false);
		}
	});
});
