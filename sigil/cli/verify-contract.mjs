#!/usr/bin/env node
import fs from 'node:fs';
import { verifyContractFiles } from '../relay/v1/verify-contract.mjs';

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const contract = value('--contract'); const registry = value('--registry');
if (!contract || !registry) { console.error('usage: verify-contract --contract path --registry path'); process.exit(2); }
const result = verifyContractFiles(contract, registry); console.log(JSON.stringify(result));
if (!result.valid) process.exitCode = 1;
