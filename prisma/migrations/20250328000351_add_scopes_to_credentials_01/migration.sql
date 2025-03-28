-- AlterTable
ALTER TABLE "MarketingPlatform" 
ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updated_at" TIMESTAMP(3);

-- Backfill updated_at with created_at (or now) for existing rows
UPDATE "MarketingPlatform" SET "updated_at" = COALESCE("created_at", CURRENT_TIMESTAMP) WHERE "updated_at" IS NULL;

-- Make updated_at non-nullable
ALTER TABLE "MarketingPlatform" ALTER COLUMN "updated_at" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "MarketingPlatform_user_id_platform_name_key" ON "MarketingPlatform"("user_id", "platform_name");