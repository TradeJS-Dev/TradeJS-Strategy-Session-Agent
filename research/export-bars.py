"""Read the archived Bybit M15 candles from TradeJS Timescale into a study folder."""
import argparse
import gzip
import json
import re
import shutil
import subprocess
from pathlib import Path

CALIBRATION = Path(__file__).resolve().parents[1] / 'calibration'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--container', default='inv-timescale')
    args = parser.parse_args()
    target = args.output / 'bars'
    target.mkdir(parents=True, exist_ok=True)
    universe = args.output / 'universe.json'
    shutil.copyfile(CALIBRATION / 'bybit-universe.json', universe)
    shutil.copyfile(CALIBRATION / 'bybit-lots.json', args.output / 'lot-rules.json')
    for symbol in json.loads(universe.read_text()):
        if not re.fullmatch(r'[A-Z0-9]+USDT', symbol):
            raise ValueError(f'Invalid archived USDT contract {symbol}')
        output = target / (symbol + '.gz')
        if output.exists():
            continue
        sql = f"""COPY (
            SELECT (extract(epoch FROM ts)*1000)::bigint,open,high,low,close,volume,
                   coalesce(turnover,volume*close)
            FROM candles
            WHERE provider='bybit' AND interval=15 AND symbol='{symbol}'
              AND ts>='2024-11-17 00:00Z' AND ts<'2026-11-18 00:00Z'
            ORDER BY ts
        ) TO STDOUT WITH CSV;"""
        command = ['docker', 'exec', '-i', args.container, 'sh', '-c',
                   'psql -Xq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
        temporary = output.with_suffix('.tmp')
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as process:
            process.stdin.write(sql.encode())
            process.stdin.close()
            with gzip.open(temporary, 'wb', compresslevel=1) as destination:
                shutil.copyfileobj(process.stdout, destination)
            if process.wait():
                temporary.unlink()
                raise RuntimeError(f'Timescale export failed for {symbol}')
        temporary.replace(output)


if __name__ == '__main__':
    main()
