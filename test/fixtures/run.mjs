export function makeResult(overrides = {}) {
  return {
    agent: "a",
    agentSource: "user",
    task: "t",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

export function makeRun({ agent = "a", task = "t", ...overrides } = {}) {
  return {
    agent,
    task,
    startedAt: 0,
    kill: () => {},
    result: makeResult({ agent, task }),
    ...overrides,
  };
}
