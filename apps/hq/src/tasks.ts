import type { Harness, Lane, Task, TaskEvent } from "@hq/protocol";
import { newId } from "@hq/protocol";
import type { Fleet } from "./fleet.js";
import type { World } from "./world.js";

const MAX_EVENTS = 500;

export interface NewTask {
  title: string;
  instruction: string;
  outpostId: string;
  harness: Harness;
  lane?: Lane;
  cwd?: string;
  createdBy: "user" | "garth";
}

/** Task lifecycle: create → dispatch to an Outpost → ingest agent events → finish → notify. */
export class Tasks {
  constructor(private world: World, private fleet: Fleet) {
    world.on("agent.event", (m: { taskId: string; agentId: string; event: TaskEvent }) => this.onEvent(m));
  }

  create(input: NewTask): Task {
    const now = Date.now();
    const task: Task = {
      id: newId("t_"),
      title: input.title,
      instruction: input.instruction,
      outpostId: input.outpostId,
      harness: input.harness,
      lane: input.lane ?? "local",
      cwd: input.cwd,
      status: "queued",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.world.tasks.set(task.id, task);
    this.world.changed();
    return task;
  }

  async dispatch(task: Task): Promise<Task> {
    try {
      const res = (await this.fleet.request(task.outpostId, "agent.run", {
        taskId: task.id,
        harness: task.harness,
        lane: task.lane,
        instruction: task.instruction,
        cwd: task.cwd,
      })) as { agentId: string };
      task.agentId = res.agentId;
      task.status = "running";
    } catch (e) {
      task.status = "failed";
      task.error = (e as Error).message;
      this.world.notify({ level: "error", title: `Could not start: ${task.title}`, body: task.error, taskId: task.id });
      this.world.emit("task.finished", task);
    }
    task.updatedAt = Date.now();
    this.world.changed();
    return task;
  }

  async cancel(taskId: string) {
    const task = this.must(taskId);
    if (task.agentId) await this.fleet.request(task.outpostId, "agent.cancel", { agentId: task.agentId }).catch(() => {});
    task.status = "cancelled";
    task.updatedAt = Date.now();
    this.world.changed();
  }

  async send(taskId: string, text: string) {
    const task = this.must(taskId);
    if (!task.agentId) throw new Error("task has no agent");
    task.status = "running";
    task.updatedAt = Date.now();
    this.world.changed();
    await this.fleet.request(task.outpostId, "agent.send", { agentId: task.agentId, text });
  }

  private onEvent({ taskId, event }: { taskId: string; agentId: string; event: TaskEvent }) {
    const task = this.world.tasks.get(taskId);
    if (!task) return;
    task.events.push(event);
    if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    task.updatedAt = event.ts;
    this.world.toUi({ type: "task.event", taskId, event });

    switch (event.type) {
      case "result":
        task.status = "done";
        task.result = String(event.payload ?? "");
        break;
      case "error":
        task.status = "failed";
        task.error = String(event.payload ?? "");
        break;
      case "status":
        if (event.payload === "waiting") task.status = "needs_input";
        else if (event.payload === "running") task.status = "running";
        break;
    }
    this.world.changed();
    if (task.status === "done" || task.status === "failed") this.world.emit("task.finished", task);
  }

  private must(id: string): Task {
    const t = this.world.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    return t;
  }
}
