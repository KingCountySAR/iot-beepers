"""
Generate the rev 1 carrier board draft: placement, nets, outline, mounting holes and labels,
then export a Specctra DSN for Freerouting. Run with KiCad's bundled Python (see build.sh).

This produced the first draft. Once the board is being edited in KiCad, edit it there
instead of re-running this, which would overwrite those edits.

Board coordinates are in mm from the top-left corner of the board; USB-C faces left.
"""
import os
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
KICAD_FP = os.environ.get('KICAD_FOOTPRINTS', r'C:/Program Files/KiCad/10.0/share/kicad/footprints')
LOCAL_FP = os.path.join(HERE, 'sar-pager.pretty')

W, H = 52.0, 32.0  # board size
ORIGIN = (100.0, 100.0)  # where the board sits on the KiCad page

# ref: (library, footprint, value, x, y, rotation, LCSC part, {pad: net})
# Nets follow hardware/rev1/README.md. XIAO pins: 1-7 = D0-D6, 8-11 = D7-D10, 12 3V3, 13 GND, 14 5V.
PARTS = {
    'U1': (None, 'Seeed_XIAO_ESP32C3', 'XIAO_ESP32C3', 10.5, 16.0, 90, '',
           {'2': 'ALARM', '3': 'BUTTON', '4': 'SWITCH', '7': 'LED_G', '11': 'LED_R', '13': 'GND', '14': '+5V'}),
    # Alarm: +5V -> R1 -> BZ1 -> Q1 drain; D1 across the coil; R3 holds the gate low at boot.
    'BZ1': ('Buzzer_Beeper', 'Buzzer_12x9.5RM7.6', '12mm passive 5V', 25.7, 9.0, 0, '',
            {'1': 'BZ_P', '2': 'BZ_N'}),
    'R1': ('Resistor_SMD', 'R_1206_3216Metric', '10R', 24.5, 20.0, 90, 'C17903', {'1': '+5V', '2': 'BZ_P'}),
    'D1': ('Diode_SMD', 'D_SOD-123', '1N4148W', 29.5, 17.6, 0, 'C81598', {'1': 'BZ_P', '2': 'BZ_N'}),
    'Q1': ('Package_TO_SOT_SMD', 'SOT-23', 'AO3400A', 33.6, 21.5, 0, 'C20917', {'1': 'GATE', '2': 'GND', '3': 'BZ_N'}),
    'R2': ('Resistor_SMD', 'R_0603_1608Metric', '100R', 29.6, 21.0, 0, 'C22775', {'1': 'ALARM', '2': 'GATE'}),
    'R3': ('Resistor_SMD', 'R_0603_1608Metric', '100k', 29.6, 23.2, 0, 'C25803', {'1': 'GATE', '2': 'GND'}),
    'C1': ('Capacitor_SMD', 'C_0805_2012Metric', '10uF', 24.5, 24.6, 90, 'C15850', {'1': '+5V', '2': 'GND'}),
    # Indicators
    'LED1': ('LED_THT', 'LED_D10.0mm', 'Red 10mm diffused', 43.23, 9.0, 0, '', {'1': 'GND', '2': 'LED_R_A'}),
    'R5': ('Resistor_SMD', 'R_0603_1608Metric', '100R', 38.6, 17.0, 0, 'C22775', {'1': 'LED_R', '2': 'LED_R_A'}),
    'LED2': ('LED_SMD', 'LED_0805_2012Metric', 'Green', 38.6, 21.8, 0, 'C2297', {'1': 'GND', '2': 'LED_G_A'}),
    'R4': ('Resistor_SMD', 'R_0603_1608Metric', '100R', 38.6, 24.6, 0, 'C22775', {'1': 'LED_G', '2': 'LED_G_A'}),
    # Inputs
    'SW1': ('Button_Switch_SMD', 'SW_Push_1P1T_XKB_TS-1187A', 'TS-1187A-B-A-B', 44.5, 21.8, 0, 'C318884',
            {'1': 'BUTTON', '2': 'GND'}),
    # Arm/quiet: C&K OS102011MA1QN1 right-angle slide switch under the XIAO, body flush with the
    # bottom edge, so its 2 mm wide lever sticks out 4 mm past the board (about 1.5 mm past a
    # 2 mm case wall). The body front is +2.2 mm from the pins.
    # Pin 2 is common: one lever position connects it to pin 1 (GND = quiet), the other to pin 3.
    'SW2': ('Button_Switch_THT', 'SW_Slide_SPDT_Angled_CK_OS102011MA1Q', 'OS102011MA1QN1', 10.0, H - 2.2, 0, 'C226259',
            {'1': 'GND', '2': 'SWITCH'}),
    # M2.5 holes for the case standoffs. The XIAO end keeps clear of the USB-C plug.
    'H1': ('MountingHole', 'MountingHole_2.7mm_M2.5', 'M2.5', 3.2, 3.2, 0, '', {}),
    'H2': ('MountingHole', 'MountingHole_2.7mm_M2.5', 'M2.5', 3.2, H - 3.2, 0, '', {}),
    'H3': ('MountingHole', 'MountingHole_2.7mm_M2.5', 'M2.5', W - 3.2, H - 3.2, 0, '', {}),
}

# Hand-soldered: no LCSC number, and excluded from the JLCPCB position file.
HAND_SOLDERED = {'U1', 'BZ1', 'LED1', 'SW2'}

# References kept on the silkscreen: the big parts, and R1 because it sets the volume.
SILK_LABELS = {'U1', 'BZ1', 'LED1', 'SW1', 'SW2', 'R1'}


def mm(x, y):
    return pcbnew.VECTOR2I_MM(ORIGIN[0] + x, ORIGIN[1] + y)


def rect_outline(x0, y0, x1, y1):
    poly = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
        poly.Append(mm(x, y))
    poly.SetClosed(True)
    return poly


def add_text(board, text, x, y, size=1.0, layer=pcbnew.F_SilkS):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(text)
    t.SetPosition(mm(x, y))
    t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I_MM(size, size))
    t.SetTextThickness(pcbnew.FromMM(size * 0.15))
    t.SetMirrored(layer == pcbnew.B_SilkS)  # reads correctly from the back
    board.Add(t)


def main(out_pcb):
    board = pcbnew.NewBoard(out_pcb)
    board.SetCopperLayerCount(2)

    nets = {}

    def net(name):
        if name not in nets:
            n = pcbnew.NETINFO_ITEM(board, name)
            board.Add(n)
            nets[name] = n
        return nets[name]

    for ref, (lib, name, value, x, y, rot, lcsc, pins) in PARTS.items():
        lib_path = LOCAL_FP if lib is None else os.path.join(KICAD_FP, lib + '.pretty')
        fp = pcbnew.FootprintLoad(lib_path, name)
        if fp is None:
            sys.exit(f'footprint not found: {lib}:{name}')
        fp.SetReference(ref)
        fp.SetValue(value)
        if lcsc:
            fp.SetField('LCSC', lcsc)
            fp.GetField('LCSC').SetVisible(False)
        # Small parts are labelled on the assembly (fab) drawing only; silk there just collides.
        if ref.startswith('H'):
            fp.Reference().SetVisible(False)
        elif ref not in SILK_LABELS:
            fp.Reference().SetLayer(pcbnew.F_Fab)
        fp.SetPosition(mm(x, y))
        fp.SetOrientationDegrees(rot)
        if ref.startswith('H') or ref in HAND_SOLDERED:
            fp.SetExcludedFromPosFiles(True)
        board.Add(fp)
        for pad in fp.Pads():
            if pad.GetNumber() in pins:
                pad.SetNet(net(pins[pad.GetNumber()]))
        # These GND pins are boxed in by neighbouring pads (and SW2's by the board edge too),
        # leaving room for only one thermal spoke, so connect them solidly.
        for gnd_pin in {'U1': ['13'], 'SW2': ['1']}.get(ref, []):
            fp.FindPadByNumber(gnd_pin).SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)

    # Placement files are measured from the bottom-left corner, as JLCPCB expects.
    board.GetDesignSettings().SetAuxOrigin(mm(0, H))

    # Outline
    edge = pcbnew.PCB_SHAPE(board)
    edge.SetShape(pcbnew.SHAPE_T_RECT)
    edge.SetStart(mm(0, 0))
    edge.SetEnd(mm(W, H))
    edge.SetLayer(pcbnew.Edge_Cuts)
    edge.SetWidth(pcbnew.FromMM(0.1))
    board.Add(edge)

    # No vias under the XIAO: its underside has exposed battery and test pads.
    keepout = pcbnew.ZONE(board)
    keepout.SetIsRuleArea(True)
    keepout.SetDoNotAllowVias(True)
    keepout.SetDoNotAllowTracks(False)
    keepout.SetDoNotAllowZoneFills(False)
    keepout.SetDoNotAllowPads(False)
    keepout.SetDoNotAllowFootprints(False)
    keepout.SetLayerSet(pcbnew.LSET.AllCuMask())
    keepout.Outline().AddOutline(rect_outline(0, 7.1, 21, 24.9))
    keepout.SetZoneName('no vias under XIAO')
    board.Add(keepout)

    add_text(board, 'SAR Pager rev 1', W / 2, H / 2, size=1.5, layer=pcbnew.B_SilkS)
    add_text(board, 'USB', 1.4, 16.0, size=0.8)

    pcbnew.SaveBoard(out_pcb, board)
    pcbnew.ExportSpecctraDSN(board, os.path.splitext(out_pcb)[0] + '.dsn')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'sar-pager.kicad_pcb'))
