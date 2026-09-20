#!/usr/bin/env bun
import { dispatch } from "./index";

await dispatch(process.argv.slice(2));
