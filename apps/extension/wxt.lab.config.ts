// Lab build for browser verification only (does not touch the production .output): npx wxt build -c wxt.lab.config.ts
import base from './wxt.config';
import { defineConfig } from 'wxt';

export default defineConfig({ ...(base as object), outDir: '.output-lab' });
