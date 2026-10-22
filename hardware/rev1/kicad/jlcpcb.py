"""
Write JLCPCB assembly files from the board: a BOM (Comment, Designator, Footprint, LCSC) and a
placement (CPL) file. Hand-soldered parts and mounting holes are left out (they're marked
"exclude from position files" on the board). Run with KiCad's bundled Python (see build.sh).
"""
import csv
import os
import sys
from collections import defaultdict

import pcbnew


def main(pcb, out_dir):
    board = pcbnew.LoadBoard(pcb)
    origin = board.GetDesignSettings().GetAuxOrigin()
    groups = defaultdict(list)
    placements = []
    for fp in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
        if fp.IsExcludedFromPosFiles():
            continue
        lcsc = fp.GetFieldText('LCSC') if fp.HasField('LCSC') else ''
        name = fp.GetFPID().GetLibItemName().wx_str()
        groups[(fp.GetValue(), name, lcsc)].append(fp.GetReference())
        pos = fp.GetPosition() - origin
        placements.append([
            fp.GetReference(),
            f'{pcbnew.ToMM(pos.x):.3f}mm',
            f'{-pcbnew.ToMM(pos.y):.3f}mm',  # JLCPCB's Y axis points up
            'Top' if fp.GetLayer() == pcbnew.F_Cu else 'Bottom',
            f'{fp.GetOrientationDegrees():.0f}',
        ])

    with open(os.path.join(out_dir, 'bom-jlcpcb.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Comment', 'Designator', 'Footprint', 'JLCPCB Part #'])  # LCSC numbers are JLCPCB's
        for (value, footprint, lcsc), refs in sorted(groups.items(), key=lambda g: g[1][0]):
            w.writerow([value, ','.join(refs), footprint, lcsc])

    with open(os.path.join(out_dir, 'cpl-jlcpcb.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])
        w.writerows(placements)
    print(f'{len(placements)} parts for assembly in {len(groups)} BOM lines')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
