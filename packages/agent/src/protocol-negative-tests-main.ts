import { runProtocolNegativeTestAcceptance } from "./protocol-negative-tests.js";

const report = await runProtocolNegativeTestAcceptance();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
