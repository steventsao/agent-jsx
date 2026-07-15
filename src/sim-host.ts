/**
 * SimHost: an in-memory AgentHost + simulated world, so the whole model runs
 * deterministically in one process with zero services.
 *
 * It plays the role cloudflare/agents' Durable Object plays in production
 * (docs/cloudflare-adapter.md maps each piece):
 *   - reconcile(): diff desired infra vs live records by (kind, name).
 *     Config changes → update. Function props → silently rebound (never
 *     compared, never persisted) — like onClick in react-dom.
 *   - tick(): advances world time; fires sensors on their interval, schedules
 *     on theirs, completes subagent work after a fixed latency.
 *   - snapshot()/restore(): "hibernation". Only configs survive — restored
 *     records are inert (handlers dead) until the next commit rebinds them.
 */

import type { AgentHost, HostOp, InfraRecord } from "./types.ts";
import { resultBindingName } from "./tree.ts";

interface LiveRecord extends InfraRecord {
  /** Restored from a snapshot and not yet rebound by a commit. */
  dormant: boolean;
}

export interface World {
  /** HTTP status of a url at world time t. */
  statusAt: (url: string, t: number) => number;
  /** Ticks a subagent takes to finish its work. */
  subagentLatency?: number;
  /** Optional deterministic subagent transport for examples/tests. */
  subagentResult?: (record: InfraRecord, t: number) => unknown;
}

const key = (kind: string, name: string) => `${kind}:${name}`;
type Flush = (fn: () => void) => void;

interface PendingWork {
  due: number;
  name: string;
  run: (flush: Flush) => void;
}

export class SimHost implements AgentHost {
  t = 0;
  readonly opLog: HostOp[] = [];
  private records = new Map<string, LiveRecord>();
  private pendingWork: PendingWork[] = [];

  constructor(private world: World) {}

  // -- AgentHost ------------------------------------------------------------

  reconcile(desired: InfraRecord[]): HostOp[] {
    const ops: HostOp[] = [];
    const seen = new Set<string>();

    for (const rec of desired) {
      const k = key(rec.kind, rec.name);
      if (seen.has(k)) throw new Error(`duplicate infra identity ${k}`);
      seen.add(k);

      const live = this.records.get(k);
      if (!live) {
        this.records.set(k, { ...rec, dormant: false });
        ops.push({ op: "create", kind: rec.kind, name: rec.name });
        this.onCreate(rec);
      } else {
        const changed = Object.keys({ ...live.config, ...rec.config }).filter(
          (p) => JSON.stringify(live.config[p]) !== JSON.stringify(rec.config[p])
        );
        const wasDormant = live.dormant;
        this.records.set(k, { ...rec, dormant: false });
        if (changed.length) ops.push({ op: "update", kind: rec.kind, name: rec.name, changed });
        else if (wasDormant) ops.push({ op: "rebind", kind: rec.kind, name: rec.name });
        // else: only handlers refreshed — not an op, same as re-rendering onClick
      }
    }

    for (const [k, live] of this.records) {
      if (!seen.has(k)) {
        this.records.delete(k);
        this.pendingWork = this.pendingWork.filter((w) => {
          if (w.name !== live.name) return true;
          this.log(`   ✂ cancelled in-flight work for ${k}`);
          return false;
        });
        ops.push({ op: "remove", kind: live.kind, name: live.name });
      }
    }

    this.opLog.push(...ops);
    return ops;
  }

  // -- world ----------------------------------------------------------------

  /** Advance one tick. `flush` wraps handler dispatch in React's flushSync. */
  tick(flush: (fn: () => void) => void): void {
    this.t++;

    for (const rec of this.records.values()) {
      if (rec.dormant) continue;
      if (rec.kind === "sensor" && this.t % (rec.config.interval as number) === 0) {
        const status = this.world.statusAt(rec.config.url as string, this.t);
        flush(() => rec.handlers.onStatus?.(status, this.t));
      }
      if (rec.kind === "schedule" && this.t % (rec.config.every as number) === 0) {
        flush(() => rec.handlers.onFire?.(this.t));
      }
    }

    const due = this.pendingWork.filter((w) => w.due <= this.t);
    this.pendingWork = this.pendingWork.filter((w) => w.due > this.t);
    for (const w of due) flush(() => w.run(flush));
  }

  private onCreate(rec: InfraRecord): void {
    if (rec.kind === "subagent") this.armSubagent(rec.name);
    if (rec.kind === "task") this.armTask(rec.name);
  }

  /** One-shot <task>: run once (next tick), fold via onDone. Freshest
   *  handlers resolve at fire time; unmount cancels via pendingWork. */
  armTask(name: string): void {
    this.pendingWork.push({
      due: this.t + 1,
      name,
      run: (flush) => {
        const live = this.records.get(key("task", name));
        if (!live) return;
        const result = live.handlers.run?.();
        // Async task completions re-enter through the same flush path as
        // sensors, schedules, and client events.
        if (result && typeof (result as Promise<unknown>).then === "function") {
          void (result as Promise<unknown>).then((value) => {
            flush(() => {
              this.records.get(key("task", name))?.handlers.onDone?.(value);
            });
          });
        } else {
          live.handlers.onDone?.(result);
        }
      },
    });
  }

  /** Enqueue a subagent's work. Handlers are looked up at fire time, so a
   *  re-render (or a post-hibernation rebind) always gets fresh closures. A
   *  completion carries a structured output: it is delivered to the boundary's
   *  reserved `__emit` channel (present when the boundary has a render-prop
   *  continuation) BEFORE its `onResult` callback — the parent writes the
   *  output into its reserved slot, re-renders, and the continuation expands
   *  its grandchildren. */
  private armSubagent(name: string): void {
    this.pendingWork.push({
      due: this.t + (this.world.subagentLatency ?? 2),
      name,
      run: () => {
        const live = this.records.get(key("subagent", name));
        if (!live) return;
        const result =
          this.world.subagentResult?.(live, this.t) ??
          `[${name}] investigated ${JSON.stringify(live.config)} → root cause: upstream dependency`;
        if (live.bindings?.__emit?.kind === "continuation") live.handlers.__emit?.(result);
        const resultBinding = resultBindingName(live);
        if (resultBinding) live.handlers[resultBinding]?.(result);
      },
    });
  }

  // -- hibernation ----------------------------------------------------------

  /** Serialize durable records (configs only — closures cannot survive). */
  snapshot(): string {
    return JSON.stringify(
      [...this.records.values()].map(({ kind, name, config }) => ({ kind, name, config }))
    );
  }

  static restore(json: string, world: World, t = 0): SimHost {
    const host = new SimHost(world);
    host.t = t;
    for (const rec of JSON.parse(json) as InfraRecord[]) {
      host.records.set(key(rec.kind, rec.name), {
        ...rec,
        handlers: {}, // dead until the next commit rebinds
        dormant: true,
      });
      // In-flight work died with the process; the durable runtime re-arms it
      // on wake (what DO alarms / workflow retries do). Handlers resolve at
      // fire time, so the post-wake render supplies fresh closures.
      if (rec.kind === "subagent") host.armSubagent(rec.name);
      if (rec.kind === "task") host.armTask(rec.name);
    }
    return host;
  }

  get liveRecords(): ReadonlyMap<string, LiveRecord> {
    return this.records;
  }

  log(msg: string): void {
    console.log(msg);
  }
}

export function formatOps(ops: HostOp[], t: number): string[] {
  const sym = { create: "+", update: "~", remove: "-", rebind: "↻" } as const;
  return ops.map(
    (o) =>
      `t=${String(t).padStart(2)}  ${sym[o.op]} ${o.kind} ${o.name}` +
      (o.op === "update" ? ` (${o.changed.join(", ")})` : "")
  );
}
