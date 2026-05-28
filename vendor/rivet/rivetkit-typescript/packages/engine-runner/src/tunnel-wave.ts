import * as protocol from "@rivetkit/engine-runner-protocol";
import { idToStr } from "./utils";

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

export function tunnelFrameKindForServerMessage(
	messageKind: protocol.ToServerTunnelMessageKind,
): protocol.TunnelFrameKind {
	switch (messageKind.tag) {
		case "ToServerResponseStart":
		case "ToServerResponseChunk":
		case "ToServerResponseAbort":
			return protocol.TunnelFrameKind.Http;
		case "ToServerWebSocketOpen":
		case "ToServerWebSocketMessage":
		case "ToServerWebSocketMessageAck":
		case "ToServerWebSocketClose":
			return protocol.TunnelFrameKind.WebSocket;
	}
}

export function tunnelFrameKindForClientMessage(
	messageKind: protocol.ToClientTunnelMessageKind,
): protocol.TunnelFrameKind {
	switch (messageKind.tag) {
		case "ToClientRequestStart":
		case "ToClientRequestChunk":
		case "ToClientRequestAbort":
			return protocol.TunnelFrameKind.Http;
		case "ToClientWebSocketOpen":
		case "ToClientWebSocketMessage":
		case "ToClientWebSocketClose":
			return protocol.TunnelFrameKind.WebSocket;
	}
}

export function buildToServerTickWaves(
	messages: readonly protocol.ToServerTunnelMessage[],
	nextEpochByGateway: Map<string, bigint>,
): protocol.ToServerTickWave[] {
	const gatewayOrder: ArrayBuffer[] = [];
	const framesByGateway = new Map<string, protocol.TunnelFrame[]>();

	for (const message of messages) {
		const gatewayId = message.messageId.gatewayId;
		const gatewayKey = idToStr(gatewayId);
		let frames = framesByGateway.get(gatewayKey);
		if (!frames) {
			frames = [];
			framesByGateway.set(gatewayKey, frames);
			gatewayOrder.push(gatewayId);
		}

		const sequence = BigInt(message.messageId.messageIndex);
		frames.push({
			requestId: message.messageId.requestId,
			sequenceRange: {
				first: sequence,
				last: sequence,
			},
			messageKind: tunnelFrameKindForServerMessage(message.messageKind),
			bytes: exactArrayBuffer(
				protocol.encodeToServerTunnelMessageKind(message.messageKind),
			),
		});
	}

	return gatewayOrder.map((gatewayId) => {
		const gatewayKey = idToStr(gatewayId);
		const epoch = nextEpochByGateway.get(gatewayKey) ?? 1n;
		nextEpochByGateway.set(gatewayKey, epoch + 1n);

		return {
			wave: {
				epoch,
				gatewayId,
				frames: framesByGateway.get(gatewayKey) ?? [],
				backpressure: null,
			},
		};
	});
}

export function partitionToServerTunnelMessagesByPressure(
	messages: readonly protocol.ToServerTunnelMessage[],
	pressureByGateway: Map<string, protocol.Pressure>,
	pressureByRequest: Map<string, protocol.Pressure> = new Map(),
): {
	ready: protocol.ToServerTunnelMessage[];
	blocked: protocol.ToServerTunnelMessage[];
} {
	const ready: protocol.ToServerTunnelMessage[] = [];
	const blocked: protocol.ToServerTunnelMessage[] = [];

	for (const message of messages) {
		const pressures = pressureEntriesForMessage(
			message,
			pressureByGateway,
			pressureByRequest,
		);
		if (pressures.length === 0) {
			ready.push(message);
			continue;
		}

		if (pressures.some(({ pressure }) => pressure.credit === 0)) {
			blocked.push(message);
			continue;
		}

		const cost = toServerTunnelMessagePressureCost(message);
		const exhausted = pressures.filter(({ pressure }) => cost > pressure.credit);
		if (exhausted.length > 0) {
			blocked.push(message);
			for (const { key, map, pressure } of exhausted) {
				map.set(key, {
					...pressure,
					credit: 0,
				});
			}
			continue;
		}

		ready.push(message);
		for (const { key, map, pressure } of pressures) {
			map.set(key, {
				...pressure,
				credit: pressure.credit - cost,
			});
		}
	}

	return { ready, blocked };
}

export function requestPressureKey(
	gatewayId: protocol.GatewayId,
	requestId: protocol.RequestId,
): string {
	return `${idToStr(gatewayId)}:${idToStr(requestId)}`;
}

type PressureEntry = {
	key: string;
	map: Map<string, protocol.Pressure>;
	pressure: protocol.Pressure;
};

function pressureEntriesForMessage(
	message: protocol.ToServerTunnelMessage,
	pressureByGateway: Map<string, protocol.Pressure>,
	pressureByRequest: Map<string, protocol.Pressure>,
): PressureEntry[] {
	const gatewayKey = idToStr(message.messageId.gatewayId);
	const requestKey = requestPressureKey(
		message.messageId.gatewayId,
		message.messageId.requestId,
	);
	const entries: PressureEntry[] = [];
	const gatewayPressure = pressureByGateway.get(gatewayKey);
	if (gatewayPressure) {
		entries.push({
			key: gatewayKey,
			map: pressureByGateway,
			pressure: gatewayPressure,
		});
	}

	const requestPressure = pressureByRequest.get(requestKey);
	if (requestPressure) {
		entries.push({
			key: requestKey,
			map: pressureByRequest,
			pressure: requestPressure,
		});
	}

	return entries;
}

const MAX_U32 = 0xffffffff;

export function aggregateGatewayPressures(
	pressures: Iterable<protocol.Pressure>,
): protocol.Pressure | null {
	let aggregate: protocol.Pressure | null = null;

	for (const pressure of pressures) {
		if (!aggregate) {
			aggregate = { ...pressure };
			continue;
		}

		aggregate = {
			credit: Math.min(aggregate.credit, pressure.credit),
			queueDepth: Math.min(
				aggregate.queueDepth + pressure.queueDepth,
				MAX_U32,
			),
			oldestAgeMs: maxOptionalU64(
				aggregate.oldestAgeMs,
				pressure.oldestAgeMs,
			),
		};
	}

	return aggregate;
}

function maxOptionalU64(
	left: protocol.u64 | null,
	right: protocol.u64 | null,
): protocol.u64 | null {
	if (left === null) return right;
	if (right === null) return left;
	return left > right ? left : right;
}

export function toServerTunnelMessagePressureCost(
	message: protocol.ToServerTunnelMessage,
): number {
	return protocol.encodeToServerTunnelMessageKind(message.messageKind)
		.byteLength;
}

export function pressureFromTunnelControl(
	control: protocol.TunnelControl,
): protocol.TunnelPressure | undefined {
	if (control.tag !== "TunnelPressure") {
		return undefined;
	}

	return control.val;
}

export function decodeToClientTickWave(
	wave: protocol.TickWave,
): protocol.ToClientTunnelMessage[] {
	return wave.frames.map((frame) => {
		if (frame.sequenceRange.first !== frame.sequenceRange.last) {
			throw new Error(
				`cannot decode multi-message Tunnel v2 sequence range ${frame.sequenceRange.first}..=${frame.sequenceRange.last}`,
			);
		}

		if (frame.sequenceRange.first > 0xffffn) {
			throw new Error(
				`Tunnel v2 sequence ${frame.sequenceRange.first} exceeds runner message index range`,
			);
		}

		const messageKind = protocol.decodeToClientTunnelMessageKind(
			new Uint8Array(frame.bytes),
		);
		const expected = tunnelFrameKindForClientMessage(messageKind);
		if (frame.messageKind !== expected) {
			throw new Error(
				`Tunnel v2 frame kind mismatch: expected ${expected}, got ${frame.messageKind}`,
			);
		}

		return {
			messageId: {
				gatewayId: wave.gatewayId,
				requestId: frame.requestId,
				messageIndex: Number(frame.sequenceRange.first),
			},
			messageKind,
		};
	});
}
