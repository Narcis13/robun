#!/usr/bin/env bun
// robun - AI agent framework
// Entry point: CLI command dispatch

import {
  VERSION,
  onboard,
  gateway,
  agent,
  status,
  channelsCmd,
  cronCmd,
  providerCmd,
  printVersion,
  printHelp,
} from "./cli";

export { VERSION };

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "onboard":
    await onboard();
    break;
  case "gateway":
    await gateway(args.slice(1));
    break;
  case "agent":
    await agent(args.slice(1));
    break;
  case "status":
    await status();
    break;
  case "channels":
    await channelsCmd(args.slice(1));
    break;
  case "cron":
    await cronCmd(args.slice(1));
    break;
  case "provider":
    await providerCmd(args.slice(1));
    break;
  case "--version":
  case "-v":
    printVersion();
    break;
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    printHelp();
    break;
}
