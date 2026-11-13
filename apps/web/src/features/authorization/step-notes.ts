/*
 * The line of status under each step of the authorization stepper.
 *
 * Kept as a pure function because one of its answers matters: in the recorded
 * demo nothing is signed, so a finished signature step must never read
 * "Signed".
 */

export type StepId = 'prepare' | 'policy' | 'execution' | 'lending' | 'submit';
export type StepStatus = 'done' | 'current' | 'upcoming';

export function stepStatus(index: number, currentIndex: number): StepStatus {
  if (index < currentIndex) return 'done';
  return index === currentIndex ? 'current' : 'upcoming';
}

function signatureNote(ordinal: 1 | 2, status: StepStatus, isDemo: boolean): string {
  if (status === 'done') return isDemo ? 'Demo placeholder, not signed' : 'Signed';
  if (status === 'current') return `Signature ${ordinal} of 2 · sign now`;
  return `Signature ${ordinal} of 2`;
}

export function stepNote(step: StepId, status: StepStatus, isDemo: boolean): string {
  switch (step) {
    case 'prepare':
      return status === 'done' ? 'Terms fixed' : 'Get the exact terms';
    case 'policy':
      return signatureNote(1, status, isDemo);
    case 'execution':
      return signatureNote(2, status, isDemo);
    case 'lending':
      // Only present when a market on the route requires a permission.
      if (status === 'done') return 'Permissions given';
      return status === 'current' ? 'Required by the markets' : 'Asked by the lending markets';
    case 'submit':
      if (status === 'done') return isDemo ? 'Replay opened' : 'Submitted';
      return status === 'current' ? 'Ready to start' : 'Nothing moves before this';
  }
}
