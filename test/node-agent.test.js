// Aggregator: the node agent plane probe lives under test/control-plane/ so it
// sits next to the other control-plane suites, while the repository test script
// only globs test/*.test.js. Importing it here keeps one deterministic runner.
import "./control-plane/node-agent.test.js";
