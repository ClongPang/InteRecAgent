import { runProtocolAdversarialAcceptance } from "./protocol-adversarial.js";

const report = await runProtocolAdversarialAcceptance();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
