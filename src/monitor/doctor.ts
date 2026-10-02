export interface DoctorProbe {
  name: string;
  check: () => Promise<string> | string;
}
/** Component checks never send mail, navigate monitored URLs or write history. */
export async function runDoctor(probes: DoctorProbe[]) {
  return Promise.all(
    probes.map(async (probe) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const detail = await Promise.race([
          Promise.resolve().then(probe.check),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Component check timed out')), 45000);
          })
        ]);
        return { component: probe.name, ok: true, detail };
      } catch {
        return {
          component: probe.name,
          ok: false,
          detail:
            'Component check failed; use the component runbook. Credentials and private connection details are intentionally omitted.'
        };
      } finally {
        clearTimeout(timer);
      }
    })
  );
}
