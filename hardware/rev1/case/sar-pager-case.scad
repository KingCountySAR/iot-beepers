// SAR Pager rev 1 case: base, lid, button, light pipe and LED spacer for the
// 52 x 32 mm carrier board in ../kicad. Part positions come from the board
// (KiCad coordinates: mm from the board's top-left corner, Y down).
//
// Render one part:   openscad -D 'part="base"' -o base.stl sar-pager-case.scad
// Parts: base, lid, button, led_spacer, assembly (preview only), all (print plate)
//
// Assembly: solder LED1 with led_spacer under it so its flange ends up just under the
// lid. Drop the button and light pipe into the lid from inside, put the board in the
// base, put the lid on, and fasten with 3x M2.5 x 12 screws from underneath. They pass
// through the floor and the board's mounting holes and thread into the lid's posts.

part = "assembly";

/* [Board] */
board = [52, 32];
board_t = 1.6;
holes = [[3.2, 3.2], [3.2, 28.8], [48.8, 28.8]];   // M2.5 mounting holes (KiCad coordinates)

/* [Parts on the board (KiCad coordinates)] */
led1_xy = [44.5, 9.0];       // 10 mm red LED, body centre
bz1_xy = [29.5, 9.0];        // 12 mm buzzer, body centre
sw1_xy = [44.5, 21.8];       // tactile switch
led2_xy = [38.6, 21.8];      // green 0805 LED
usb_y = 16.0;                // XIAO centre line; USB-C is on the left edge (x = 0)
sw2_lever_x = [10.0, 14.3];  // slide switch lever, both positions (x range)

/* [Heights above the board's top surface] */
buzzer_h = 9.5;              // 12 x 9.5 mm buzzer
sw1_h = 1.5;                 // TS-1187A actuator top
led2_h = 0.8;                // 0805 LED top
// Light pipe over LED2: a piece of 1/16" clear acrylic rod, glued into a guide tube in the lid.
lightpipe_d = 1.5875;        // 1/16"
lightpipe_hole = 1.8;        // slip fit; printed holes come out a little small
lightpipe_proud = 0.5;       // how far the rod stands above the lid
lightpipe_gap = 1.0;         // rod end to LED top
lightpipe_guide = 3.0;       // guide tube below the lid
sw2_lever_z = [1.6, 3.6];    // slide switch lever, bottom and top (from the KiCad 3D model)
usb_z = 2.5;                 // centre of the XIAO's USB-C receptacle (XIAO soldered flat)
led1_flange_h = 1.5;         // 10 mm LED flange thickness
led1_h = 13.5;               // 10 mm LED, bottom of flange to top of dome
led1_dome = 5.0;             // how far the LED stands above the lid (its dome)

/* [Case] */
wall = 2.0;
floor_t = 2.0;
lid_t = 2.0;
gap = 0.5;                   // board edge to inside of the wall
standoff_h = 3.0;            // room for clipped through-hole leads under the board
headroom = 10.0;             // board top to lid underside (buzzer is 9.5)
corner_r = 3.0;
fit = 0.2;                   // clearance between printed parts that slide together
usb_opening = [13.0, 8.0];   // width x height; fits most USB-C cable overmolds
screw_d = 2.9;               // M2.5 clearance
pilot_d = 2.2;               // M2.5 thread-forming into plastic
screw_head_d = 5.2;
screw_head_h = 1.6;
post_d = 5.5;

$fn = 64;

// ---- derived ---------------------------------------------------------------

inner = board + [2, 2] * gap;
outer = inner + [2, 2] * wall;
pcb_top = floor_t + standoff_h + board_t;      // z of the board's top surface
lid_z = pcb_top + headroom;                    // z of the lid's underside (= top of base walls)
height = lid_z + lid_t;

// KiCad board coordinates -> case XY (case origin is the outer bottom-left corner).
function at(p) = [wall + gap + p[0], wall + gap + board[1] - p[1]];

// Wall openings: [x, y, z] origin, size, and how far down the lid's filler tab reaches.
usb_cut_y = at([0, usb_y])[1];
usb_cut = [usb_cut_y - usb_opening[0] / 2, pcb_top + usb_z - usb_opening[1] / 2];
sw2_cut_x = [at([sw2_lever_x[0], 0])[0] - 0.6, at([sw2_lever_x[1], 0])[0] + 0.6];
sw2_cut_z = [pcb_top + sw2_lever_z[0] - 0.5, pcb_top + sw2_lever_z[1] + 0.5];
usb_top = usb_cut[1] + usb_opening[1];
// LED1's flange height: only its dome shows above the lid.
led1_flange_z = height + led1_dome - led1_h;

module rounded_box(size, r, h) {
    linear_extrude(h)
        offset(r) offset(-r) square(size);
}

// ---- base ------------------------------------------------------------------

module base() {
    difference() {
        union() {
            difference() {
                rounded_box(outer, corner_r, lid_z);
                translate([wall, wall, floor_t]) rounded_box(inner, corner_r - wall, lid_z);
            }
            for (h = holes) translate([each at(h), 0]) cylinder(d = post_d, h = floor_t + standoff_h);
        }
        // Screws come up from underneath, heads recessed into the floor.
        for (h = holes) translate([each at(h), -1]) {
            cylinder(d = screw_d, h = height);
            cylinder(d = screw_head_d, h = screw_head_h + 1);
        }
        // USB-C (left wall), open to the top so the board drops in; the lid fills the rest.
        translate([-1, usb_cut[0], usb_cut[1]]) cube([wall + 2, usb_opening[0], height]);
        // Slide switch lever (bottom wall), open to the top the same way.
        translate([sw2_cut_x[0], -1, sw2_cut_z[0]]) cube([sw2_cut_x[1] - sw2_cut_x[0], wall + 2, height]);
    }
}

// ---- lid -------------------------------------------------------------------
// Modelled in place (underside at z = lid_z); `lid_print` flips it top-down for printing.

module lid() {
    difference() {
        union() {
            translate([0, 0, lid_z]) rounded_box(outer, corner_r, lid_t);
            // Locating lip just inside the walls.
            translate([0, 0, lid_z - 1.5]) difference() {
                translate([wall + fit, wall + fit]) rounded_box(inner - [2, 2] * fit, corner_r - wall, 1.5);
                translate([wall + 1.4, wall + 1.4]) rounded_box(inner - [2.8, 2.8], 1, 2);
            }
            // Posts the screws thread into; they also clamp the board.
            for (h = holes) translate([each at(h), pcb_top]) cylinder(d = post_d, h = headroom);
            // Tabs that close the tops of the wall openings.
            translate([fit, usb_cut[0] + fit, usb_top + fit]) cube([wall - fit, usb_opening[0] - 2 * fit, lid_z - usb_top]);
            translate([sw2_cut_x[0] + fit, fit, sw2_cut_z[1] + fit])
                cube([sw2_cut_x[1] - sw2_cut_x[0] - 2 * fit, wall - fit, lid_z - sw2_cut_z[1]]);
            // Collar down to LED1's flange: locates it and keeps its light out of the case.
            translate([each at(led1_xy), led1_flange_z + led1_flange_h + 0.3])
                cylinder(d = 13, h = lid_z - (led1_flange_z + led1_flange_h + 0.3));
            // Guide tube for the light pipe rod: holds it straight and keeps the light in.
            translate([each at(led2_xy), lid_z - lightpipe_guide]) cylinder(d = lightpipe_hole + 1.4, h = lightpipe_guide);
            // Guide sleeve for the button.
            translate([each at(sw1_xy), lid_z - 3]) cylinder(d = 9.0, h = 3);
        }
        for (h = holes) translate([each at(h), pcb_top - 1]) cylinder(d = pilot_d, h = headroom - 1);
        // LED1 pokes through the lid and its collar.
        translate([each at(led1_xy), led1_flange_z]) cylinder(d = 10.4, h = height);
        // Sound holes over the buzzer.
        translate([each at(bz1_xy), lid_z - 1]) {
            cylinder(d = 2.5, h = lid_t + 2);
            for (a = [0 : 60 : 300]) rotate(a) translate([3.8, 0]) cylinder(d = 2.0, h = lid_t + 2);
        }
        // Button.
        translate([each at(sw1_xy), lid_z - 4]) cylinder(d = 6.0 + 2 * fit, h = lid_t + 5);
        // Light pipe rod.
        translate([each at(led2_xy), lid_z - lightpipe_guide - 1]) cylinder(d = lightpipe_hole, h = lightpipe_guide + lid_t + 2);
    }
}

// ---- small parts (modelled in place) ----------------------------------------

// Cap above the lid, stem through it, a flange under it to stop it falling out, and a
// plunger down to the switch. The flange's top is a 45° cone so the button prints cap-down
// without supports; the cone still catches on the sleeve's edge.
button_proud = 1.2;
module button() {
    xy = at(sw1_xy);
    stem_d = 6.0;
    flange_d = 8.2;
    flange_t = 0.8;                              // straight part under the cone
    taper_h = (flange_d - stem_d) / 2;           // 45°
    flange_z = lid_z - 3 - taper_h - flange_t;   // bottom of the flange
    translate([each xy, 0]) {
        translate([0, 0, lid_z]) cylinder(d = stem_d, h = lid_t + button_proud);
        translate([0, 0, lid_z - 3]) cylinder(d = stem_d, h = 3);                       // inside the sleeve
        translate([0, 0, flange_z + flange_t]) cylinder(d1 = flange_d, d2 = stem_d, h = taper_h);
        translate([0, 0, flange_z]) cylinder(d = flange_d, h = flange_t);
        translate([0, 0, pcb_top + sw1_h + 0.2]) cylinder(d = 3.0, h = flange_z - (pcb_top + sw1_h + 0.2));
    }
}

// Preview only: the light pipe rod. Cut it to this length (echoed when rendering).
lightpipe_len = height + lightpipe_proud - (pcb_top + led2_h + lightpipe_gap);
echo(lightpipe_len = lightpipe_len);
module lightpipe() {
    translate([each at(led2_xy), 0]) {
        translate([0, 0, pcb_top + led2_h + lightpipe_gap]) cylinder(d = lightpipe_d, h = lightpipe_len);
    }
}

// Sits under LED1 while soldering so only its dome ends up above the lid.
led_spacer_h = led1_flange_z - pcb_top;
module led_spacer() {
    translate([each at(led1_xy), pcb_top]) difference() {
        translate([-3.5, -2.5, 0]) cube([7, 5, led_spacer_h]);
        for (dx = [-1.27, 1.27]) translate([dx, 0, -1]) cylinder(d = 1.2, h = led_spacer_h + 2);
    }
}

// ---- preview of the board and parts ----------------------------------------

module board_preview() {
    color("darkgreen") translate([wall + gap, wall + gap, pcb_top - board_t]) cube([each board, board_t]);
    color("dimgray") translate([wall + gap, at([0, usb_y])[1] - 8.9, pcb_top]) cube([21, 17.8, 3.2]);    // XIAO
    color("silver") translate([wall + gap - 1.2, at([0, usb_y])[1] - 4.5, pcb_top + usb_z - 1.6]) cube([7.5, 9, 3.2]);
    color("black") translate([each at(bz1_xy), pcb_top]) cylinder(d = 12, h = buzzer_h);
    color("red") translate([each at(led1_xy), pcb_top + led_spacer_h]) {
        cylinder(d = 11.2, h = led1_flange_h);
        cylinder(d = 10, h = led1_h - 5);
        translate([0, 0, led1_h - 5]) sphere(d = 10);
    }
    color("white") translate([at([sw2_lever_x[0] - 2.3, 0])[0], wall + gap, pcb_top]) cube([8.6, 4.4, 4.7]);
    color("black") translate([at([sw2_lever_x[0], 0])[0], wall + gap - 4, pcb_top + sw2_lever_z[0]]) cube([2.3, 4, 2]);
    color("beige") translate([each at(sw1_xy) - [2.55, 2.55], pcb_top]) cube([5.1, 5.1, sw1_h]);
}

module lid_print() { translate([0, outer[1], height]) rotate([180, 0, 0]) lid(); }
module button_print() { translate([0, 0, lid_z + lid_t + button_proud]) rotate([180, 0, 0]) translate([-at(sw1_xy)[0], -at(sw1_xy)[1], 0]) button(); }
module led_spacer_print() { translate([-at(led1_xy)[0], -at(led1_xy)[1], -pcb_top]) led_spacer(); }

if (part == "base") base();
else if (part == "lid") lid_print();
else if (part == "button") button_print();
else if (part == "led_spacer") led_spacer_print();
else if (part == "all") {
    base();
    translate([outer[0] + 5, 0, 0]) lid_print();
    translate([2 * outer[0] + 15, 8, 0]) button_print();
    translate([2 * outer[0] + 15, 32, 0]) led_spacer_print();
} else {   // assembly: base, board and lid in place, lid see-through
    base();
    board_preview();
    color("orange") button();
    color("lightblue") lightpipe();
    color("gold") led_spacer();
    %lid();
}
