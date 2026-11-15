#!/usr/bin/env node
// Summarises routing and token use across every session on this machine.
import { formatReport, loadSessions, summarize } from "../src/report.mjs";
import { priceTable } from "../src/usage.mjs";

console.log(formatReport(summarize(loadSessions(), priceTable())));
