CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"page_id" integer NOT NULL,
	"device_id" text NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	CONSTRAINT "deliveries_page_id_device_id_pk" PRIMARY KEY("page_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "device_channels" (
	"device_id" text NOT NULL,
	"channel_id" integer NOT NULL,
	CONSTRAINT "device_channels_device_id_channel_id_pk" PRIMARY KEY("device_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "device_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text,
	"owner_id" integer,
	"name" text DEFAULT '' NOT NULL,
	"claim_code" text,
	"claim_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_connect_at" timestamp with time zone,
	"fw_version" text,
	"hw_rev" text,
	"ip" text,
	"rssi" integer,
	"uptime_s" integer,
	"free_heap" integer,
	"armed" boolean,
	"reset_reason" text,
	"fw_target" text,
	"ota_requested_at" timestamp with time zone,
	CONSTRAINT "devices_claim_code_unique" UNIQUE("claim_code")
);
--> statement-breakpoint
CREATE TABLE "firmware" (
	"version" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"idf_version" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"image" "bytea" NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_channels" ADD CONSTRAINT "device_channels_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_channels" ADD CONSTRAINT "device_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_events_device_at" ON "device_events" USING btree ("device_id","at");--> statement-breakpoint
CREATE INDEX "pages_created_at" ON "pages" USING btree ("created_at");