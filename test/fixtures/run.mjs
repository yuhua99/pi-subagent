export function makeResult(overrides = {}) {
  return {
    agent: "a",
    agentSource: "user",
    task: "t",
    status: "running",
    messages: [],
    stderr: "",
    cost: 0,
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
