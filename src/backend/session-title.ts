/** Session labels that do not represent a generated or explicit title. */
export function isPlaceholderSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? '';
  return !normalized
    || normalized === 'New OpenCode Session'
    || normalized === 'New ACP Agent Session'
    || normalized === 'New Reasonix Session'
    || normalized === 'New DSH Session'
    || normalized === 'New DeepSeek Harness Session'
    || normalized.startsWith('OpenCode Session ')
    || normalized.startsWith('ACP Session ')
    || normalized.startsWith('ACP Agent Session ')
    || normalized.startsWith('Reasonix Session ')
    || normalized.startsWith('DSH Session ')
    || normalized.startsWith('DeepSeek Harness Session ')
    || normalized.startsWith('Session ');
}
