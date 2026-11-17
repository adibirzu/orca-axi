#!/usr/bin/env node
import { runPaperclipCybCli } from "../src/paperclip/cli.js";

const code = await runPaperclipCybCli(process.argv.slice(2));
process.exitCode = code;
