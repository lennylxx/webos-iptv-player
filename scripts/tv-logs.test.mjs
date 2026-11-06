import { describe, expect, it } from 'vitest';
import { serviceLogCommand } from './tv-logs.mjs';

describe('tv-logs --service', () => {
  it('follows only new lines by default', () => {
    const command = serviceLogCommand({ history: false, seconds: 0 });

    expect(command).toContain('log="$temp_root/com.lennylxx.iptv.service.log"');
    expect(command).toContain('tail -n 0 -F "$log"');
    expect(command).not.toContain('cat "$log.1"');
    expect(command).not.toContain('kill');
    expect(command).toContain('[ -e "$log" ] || echo "tv-logs: waiting for $log; has the service started?" >&2');
  });

  it('prints the saved log first with --history and stops after --seconds', () => {
    const command = serviceLogCommand({ history: true, seconds: 30 });

    expect(command).toContain('cat "$log.1" 2>/dev/null; tail -n +1 -F "$log" 2>/dev/null'
      + ' & tail_pid=$!; sleep 30; kill $tail_pid');
    expect(command).not.toContain('timeout');
  });
});
