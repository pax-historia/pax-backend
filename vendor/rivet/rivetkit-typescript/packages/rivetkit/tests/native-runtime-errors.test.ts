import { describe, expect, test } from "vitest";
import { actor, setup } from "@/mod";
import { RivetError } from "../src/actor/errors";
import {
	ActorContextHandleAdapter,
	applyNativeBroadcastPressure,
	buildNativeFactory,
	buildServeConfig,
} from "../src/registry/native";

const testActor = actor({
	state: {},
	actions: {},
});

function createNativeActorContextHarness(options?: { stateEnabled?: boolean }) {
	const runtimeState = {};
	const runtime = {
		actorId: () => "actor-id",
		actorRuntimeState: () => runtimeState,
	};
	const ctx = {};
	const adapter = new ActorContextHandleAdapter(
		runtime as never,
		ctx as never,
		undefined,
		{},
		undefined,
		undefined,
		options?.stateEnabled ?? true,
	);
	return {
		adapter,
		ctx,
		runtime,
	};
}

function createNativeActorContextAdapter(options?: {
	stateEnabled?: boolean;
}): ActorContextHandleAdapter {
	return createNativeActorContextHarness(options).adapter;
}

function captureThrownError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}

	throw new Error("expected function to throw");
}

describe("native runtime config errors", () => {
	test("ctx.client preserves structured error fields when client is missing", () => {
		const actorCtx = createNativeActorContextAdapter();
		const error = captureThrownError(() => actorCtx.client());

		expect(error).toBeInstanceOf(RivetError);
		expect(error).toMatchObject({
			group: "native",
			code: "client_not_configured",
			message: "native actor client is not configured",
		});
	});

	test("ctx.db preserves structured error fields when database is missing", () => {
		const actorCtx = createNativeActorContextAdapter();
		const error = captureThrownError(() => actorCtx.db);

		expect(error).toBeInstanceOf(RivetError);
		expect(error).toMatchObject({
			group: "actor",
			code: "database_not_configured",
			message: "database is not configured for this actor",
		});
	});

	test("ctx.state preserves structured error fields when state is disabled", () => {
		const actorCtx = createNativeActorContextAdapter({
			stateEnabled: false,
		});
		const error = captureThrownError(() => actorCtx.state);

		expect(error).toBeInstanceOf(RivetError);
		expect(error).toMatchObject({
			group: "actor",
			code: "state_not_enabled",
			message:
				"State not enabled. Must implement `createState` or `state` to use state. (https://www.rivet.dev/docs/actors/state/#initializing-state)",
		});
	});

	test("buildServeConfig preserves structured error fields when endpoint is missing", async () => {
		const registry = setup({
			use: {
				test: testActor,
			},
			startEngine: false,
		});
		const config = registry.parseConfig();
		config.endpoint = undefined as never;

		await expect(buildServeConfig(config)).rejects.toMatchObject({
			group: "native",
			code: "endpoint_not_configured",
			message: "registry endpoint is required for native envoy startup",
		});
	});
});

describe("native runtime broadcast pressure", () => {
	test("ctx.broadcastBudget returns the default unpressured budget", () => {
		const { adapter } = createNativeActorContextHarness();

		expect(adapter.broadcastBudget()).toEqual({
			credit: 0xffffffff,
			queueDepth: 0,
			oldestAgeMs: null,
		});
	});

	test("ctx.onPressure fires synchronously and unsubscribe removes the handler", () => {
		const { adapter, ctx, runtime } = createNativeActorContextHarness();
		const seen: ReturnType<typeof adapter.broadcastBudget>[] = [];

		const unsubscribe = adapter.onPressure((pressure) => {
			seen.push(pressure);
		});

		applyNativeBroadcastPressure(runtime as never, ctx as never, {
			credit: 2048,
			queueDepth: 3,
			oldestAgeMs: 25n,
		});

		expect(seen).toEqual([
			{
				credit: 2048,
				queueDepth: 3,
				oldestAgeMs: 25,
			},
		]);
		expect(adapter.broadcastBudget()).toEqual(seen[0]);

		unsubscribe();
		applyNativeBroadcastPressure(runtime as never, ctx as never, {
			credit: 1024,
			queueDepth: 1,
			oldestAgeMs: null,
		});

		expect(seen).toHaveLength(1);
		expect(adapter.broadcastBudget()).toEqual({
			credit: 1024,
			queueDepth: 1,
			oldestAgeMs: null,
		});
	});

	test("native factory pressure callback updates actor pressure handlers", async () => {
		const runtimeState = {};
		let callbacks:
			| {
					onBroadcastPressure: (
						error: unknown,
						payload: {
							ctx: unknown;
							pressure: {
								credit: number;
								queueDepth: number;
								oldestAgeMs: bigint | null;
							};
						},
					) => Promise<void>;
			  }
			| undefined;
		const runtime = {
			kind: "napi",
			actorId: () => "actor-id",
			actorRuntimeState: () => runtimeState,
			createActorFactory: (nativeCallbacks: unknown) => {
				callbacks = nativeCallbacks as typeof callbacks;
				return {};
			},
		};
		const ctx = {};
		const adapter = new ActorContextHandleAdapter(
			runtime as never,
			ctx as never,
			undefined,
			{},
			undefined,
			undefined,
			true,
		);
		const seen: ReturnType<typeof adapter.broadcastBudget>[] = [];
		adapter.onPressure((pressure) => {
			seen.push(pressure);
		});

		const registry = setup({
			use: {
				test: testActor,
			},
			startEngine: false,
		});
		buildNativeFactory(runtime as never, registry.parseConfig(), testActor);
		if (!callbacks) {
			throw new Error("native factory callbacks were not captured");
		}

		await callbacks.onBroadcastPressure(null, {
			ctx,
			pressure: {
				credit: 0,
				queueDepth: 128,
				oldestAgeMs: 250n,
			},
		});

		expect(seen).toEqual([
			{
				credit: 0,
				queueDepth: 128,
				oldestAgeMs: 250,
			},
		]);
		expect(adapter.broadcastBudget()).toEqual(seen[0]);
	});
});
