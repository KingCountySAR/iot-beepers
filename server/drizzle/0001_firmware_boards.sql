-- Firmware is now per board. Earlier images carry no board ID, so they (and anything
-- pointing at them) are dropped; re-upload them built with firmware/build.sh.
DELETE FROM "firmware";--> statement-breakpoint
DELETE FROM "settings" WHERE "key" = 'firmware.default';--> statement-breakpoint
UPDATE "devices" SET "fw_target" = NULL;--> statement-breakpoint
ALTER TABLE "firmware" DROP CONSTRAINT "firmware_pkey";--> statement-breakpoint
ALTER TABLE "firmware" ADD COLUMN "board" text NOT NULL;--> statement-breakpoint
ALTER TABLE "firmware" ADD COLUMN "chip" text NOT NULL;--> statement-breakpoint
ALTER TABLE "firmware" ADD COLUMN "bootloader" "bytea";--> statement-breakpoint
ALTER TABLE "firmware" ADD COLUMN "partition_table" "bytea";--> statement-breakpoint
ALTER TABLE "firmware" ADD COLUMN "flash_layout" jsonb;--> statement-breakpoint
ALTER TABLE "firmware" ADD CONSTRAINT "firmware_board_version_pk" PRIMARY KEY("board","version");
