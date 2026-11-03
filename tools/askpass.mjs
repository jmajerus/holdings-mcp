#!/usr/bin/env node
// SSH_ASKPASS helper: answers ssh's password prompt from AUTHORING_DEPLOY_PASSWORD.
const password = process.env.AUTHORING_DEPLOY_PASSWORD;

if (!password) process.exit(1);
process.stdout.write(`${password}\n`);
