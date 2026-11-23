/**
 * `agent.run`: a subagent, the same loop a run thinks in (`turns.ts`, Pi's
 * agent loop) started again in a context of its own (ADR 0203). It is told
 * only the task it is given, the Account's guidance and Skill catalog, and the
 * Skills it is named to start with; it knows nothing of the conversation or
 * the run that started it. It reads with the run's own tools, runs code, and
 * plans every write it would make, as an Automation's run plans its writes:
 * none is made. Its answer, and every write it planned, go back to the run
 * that started it, which decides what to do with them.
 *
 * That is what lets a run try a Skill as the run that will next read it does:
 * from nothing but the Skill, on the model that will read it, without sending
 * or changing anything.
 */

import { BROWSER_TOOLS, toolNamed } from '@mail/domain';

import type { McpFetch } from './mcp';
import type { Rendezvous } from './rendezvous';
import { runSkills, type SkillStore } from './skills';
import { skills as skillTable } from './storage/account-schema';
import { eq } from 'drizzle-orm';
import { think, ThinkingFailed, toolCaller, type ModelConnection, type ModelPort, type RunTool, type ToolHandlers } from './turns';

/** The tool a subagent is started with, which a subagent itself is not offered. */
export const AGENT_TOOL = 'agent.run';

/** What a run lends the subagents it starts: its model, its tools, and what it is told. */
export interface SubagentContext {
  model: ModelPort;
  connection: ModelConnection;
  /** The models of the AI Connection a subagent may be run with, the default first. */
  models: readonly string[];
  /** What a run of this entrance is told, around the Skill catalog. */
  instructions: (skills: string) => string;
  skills: SkillStore;
  /** The tools the run that starts it holds. */
  tools: readonly RunTool[];
  /** The handlers of its reads; its writes are only planned. */
  handlers: ToolHandlers;
  fetch: McpFetch;
  /** Where the subagent issues a Run Token of its own, answered by its own loop, so a Skill's script it runs plans its writes too. */
  rendezvous?: Rendezvous;
  signal?: AbortSignal;
  trace?: Readonly<Record<string, string>>;
}

/** A write a subagent would have made. */
interface PlannedCall {
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * The tools a subagent is offered: the run's own, but not another subagent,
 * nor any tool that acts the moment it is called and so cannot be planned —
 * an MCP Server's, the browser's, keeping a memory, or handing a file to the
 * member.
 */
const offered = (tools: readonly RunTool[]): RunTool[] => tools.filter((tool) => tool.origin.kind === 'internal'
  && tool.name !== AGENT_TOOL
  && tool.name !== 'memory.add'
  && tool.name !== 'file.hand'
  && !(BROWSER_TOOLS as readonly string[]).includes(tool.name));

const SUBAGENT_NOTE = [
  'You are a subagent: another agent of this Account started you with the task below and reads only your final answer. You know nothing else of its conversation, so do not ask it questions; work from the task, your tools, and the Skills.',
  'Every write you make — sending a message or an email, creating or changing an event, a Task, a file, or a Skill — is planned, not made: the tool answers that it was planned, and you go on as if it were made. Say in your answer exactly what you did and what you planned, with the text of every message you would have sent.',
].join(' ');

/** Reads the arguments of one `agent.run` call, or why they cannot start one. */
const readCall = (arguments_: Record<string, unknown>, models: readonly string[]): { task: string; skills: string[]; model: string | null } | string => {
  const task = typeof arguments_.task === 'string' ? arguments_.task.trim() : '';
  if (!task) return 'agent.run requires task: everything the subagent is to know and do, since it knows nothing else.';
  const skills = Array.isArray(arguments_.skills) ? [...new Set(arguments_.skills.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map((name) => name.trim()))] : [];
  const model = typeof arguments_.model === 'string' && arguments_.model.trim() ? arguments_.model.trim() : null;
  if (model && !models.includes(model)) return `${model} is not a model of this Account's AI Connection. Name one of: ${models.join(', ')}.`;
  return { task, skills, model };
};

/** Runs one subagent to its end and answers what it said and every write it planned. */
export const runSubagent = async (context: SubagentContext, arguments_: Record<string, unknown>): Promise<unknown> => {
  const read = readCall(arguments_, context.models);
  if (typeof read === 'string') return { isError: true, message: read };
  const ids: string[] = [];
  for (const name of read.skills) {
    const row = await context.skills.db.select({ id: skillTable.id }).from(skillTable).where(eq(skillTable.name, name)).get();
    if (!row) return { isError: true, message: `No Skill is named ${JSON.stringify(name)}. Name a Skill as the catalog names it.` };
    ids.push(row.id);
  }
  const catalog = await runSkills(context.skills, ids);
  const tools = offered(context.tools);
  const reads = toolCaller({ tools, handlers: context.handlers, fetch: context.fetch });
  const planned: PlannedCall[] = [];
  const connection = read.model ? { ...context.connection, model: read.model } : context.connection;
  const outcome = (thought: { model: string; output: string; toolCallCount: number; tokens: number }) => ({
    model: thought.model,
    answer: thought.output,
    planned,
    toolCalls: thought.toolCallCount,
    tokens: thought.tokens,
  });
  try {
    const thought = await think({
      model: context.model,
      connection,
      messages: [
        { role: 'system', content: `${context.instructions(catalog.instructions)}\n\n${SUBAGENT_NOTE}` },
        { role: 'user', content: read.task },
      ],
      tools,
      call: async (name, callArguments, call) => {
        if (toolNamed(name)?.writes) {
          planned.push({ tool: name, arguments: callArguments });
          return { planned: true, message: `${name} was planned, not made, because you are a subagent. Go on as if it were made.` };
        }
        return reads(name, callArguments, call);
      },
      ...(context.rendezvous ? { rendezvous: context.rendezvous } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.trace ? { trace: { ...context.trace, subagent: 'true' } } : {}),
    });
    return outcome(thought);
  } catch (error) {
    if (!(error instanceof ThinkingFailed)) throw error;
    return { isError: true, message: `The subagent stopped: ${error.message}`, ...outcome(error.thought) };
  }
};

/** What the model is told `agent.run` is. */
export const AGENT_RUN_DESCRIPTION = [
  'Start a subagent in a fresh context told only task. It reads with your tools, runs code, and opens Skills; its writes are planned, not made. You get its answer and planned writes.',
  'Use it to hand off work whose details you need not keep, and to test a Skill after writing it: give a request worded as a member would, skills left out, model set to the one that will run it. If its plan is not what the Skill should produce, fix the Skill and try again before calling it done.',
].join(' ');
