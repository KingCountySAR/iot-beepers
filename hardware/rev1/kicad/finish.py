"""
Import Freerouting's routes (sar-pager.ses) into the generated board, add ground fill on both
layers, and fill it. Run with KiCad's bundled Python after generate.py (see build.sh).
"""
import os
import sys

import pcbnew

from generate import ORIGIN, H, W, mm, rect_outline

HERE = os.path.dirname(os.path.abspath(__file__))


def main(pcb, ses):
    board = pcbnew.LoadBoard(pcb)
    if not pcbnew.ImportSpecctraSES(board, ses):
        sys.exit(f'could not import {ses}')

    # Freerouting doesn't always keep the net class's via; every class uses 0.6/0.3 mm
    # (sar-pager.kicad_pro), which carries the ~100 mA here easily.
    for via in board.GetTracks():
        if via.GetClass() == 'PCB_VIA':
            via.SetWidth(pcbnew.FromMM(0.6))
            via.SetDrill(pcbnew.FromMM(0.3))

    gnd = board.FindNet('GND')
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        zone = pcbnew.ZONE(board)
        zone.SetLayer(layer)
        zone.SetNet(gnd)
        zone.Outline().AddOutline(rect_outline(0, 0, W, H))
        zone.SetLocalClearance(pcbnew.FromMM(0.3))
        zone.SetMinThickness(pcbnew.FromMM(0.25))
        zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        zone.SetThermalReliefGap(pcbnew.FromMM(0.4))
        zone.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.5))
        zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
        board.Add(zone)

    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(pcb, board)
    tracks = [t for t in board.GetTracks() if t.GetClass() == 'PCB_TRACK']
    vias = [t for t in board.GetTracks() if t.GetClass() == 'PCB_VIA']
    print(f'{len(tracks)} track segments, {len(vias)} vias')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sar-pager.kicad_pcb'),
         sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'sar-pager.ses'))
