export type PipelineStage =
  'load' | 'authenticate' | 'validate-readiness' | 'capture' | 'confirm-change' | 'save' | 'notify';
export interface StageRecord {
  stage: PipelineStage;
  at: string;
}
export type StageObserver = (stage: PipelineStage) => void;

/** Stage traces contain timing and operation names, never credentials or page content. */
export function createStageRecorder(
  trace: StageRecord[],
  now: () => string = () => new Date().toISOString()
): StageObserver {
  return (stage) => {
    trace.push({ stage, at: now() });
  };
}
