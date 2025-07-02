-- -- DropIndex
-- DROP INDEX "idx_linkedin_metadata_industries";

-- -- DropIndex
-- DROP INDEX "idx_linkedin_metadata_locales";

-- -- DropIndex
-- DROP INDEX "idx_linkedin_metadata_locations";

-- -- DropIndex
-- DROP INDEX "idx_linkedin_metadata_seniorities";

-- -- DropIndex
-- DROP INDEX "idx_linkedin_metadata_staff_count_ranges";

-- -- DropIndex
-- DROP INDEX "idx_linkedin_metadata_titles";

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adAccountId" TEXT,
    "content" TEXT,
    "inlineContent" TEXT,
    "name" TEXT,
    "intendedStatus" TEXT,
    "isServing" BOOLEAN,
    "servingHoldReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "leadgenCallToAction" JSONB,
    "reviewStatus" TEXT,
    "rejectionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3),
    "lastModifiedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "lastModifiedBy" TEXT,
    "eventAd" JSONB,
    "isTest" BOOLEAN DEFAULT false,
    "changeAuditStamps" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ad_id_key" ON "Ad"("id");

-- CreateIndex
CREATE INDEX "Ad_campaignId_idx" ON "Ad"("campaignId");

-- CreateIndex
CREATE INDEX "Ad_adAccountId_idx" ON "Ad"("adAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Ad_campaignId_id_key" ON "Ad"("campaignId", "id");

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE;
