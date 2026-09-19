import type { Detection } from '../types.js';
import { buildContext, type Detector, type DetectionContext } from './base.js';
import { NodeDetector } from './node.js';
import { PythonDetector, FastAPIDetector } from './python.js';
import { DockerDetector } from './docker.js';
import {
  FlutterDetector,
  AndroidDetector,
  MonorepoDetector,
  RustDetector,
  GoDetector,
  MakeDetector,
  ShellScriptDetector,
  GenericWebDetector,
  EnvFileDetector,
  UnsafeProjectDetector,
} from './others.js';

export const ALL_DETECTORS: Detector[] = [
  new DockerDetector(),
  new NodeDetector(),
  new FastAPIDetector(),
  new PythonDetector(),
  new FlutterDetector(),
  new AndroidDetector(),
  new MonorepoDetector(),
  new RustDetector(),
  new GoDetector(),
  new MakeDetector(),
  new ShellScriptDetector(),
  new GenericWebDetector(),
  new EnvFileDetector(),
  new UnsafeProjectDetector(),
];

export interface DiscoveryResult {
  root: string;
  detections: Detection[];
  context: DetectionContext;
}

export function runDetectors(root: string, detectors: Detector[] = ALL_DETECTORS): DiscoveryResult {
  const ctx = buildContext(root);
  const detections: Detection[] = [];
  for (const d of detectors) {
    try {
      const result = d.detect(ctx);
      if (result) detections.push(result);
    } catch (err) {
      detections.push({
        type: d.type,
        confidence: 0,
        evidence: [`detector threw: ${(err as Error).message}`],
        candidates: [],
      });
    }
  }
  return { root, detections, context: ctx };
}

export type { Detector, DetectionContext } from './base.js';
export { buildContext } from './base.js';
