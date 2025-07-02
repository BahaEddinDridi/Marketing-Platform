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
CREATE TABLE "AudienceTemplates" (
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "targetingCriteria" JSONB NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "approximateMemberCount" BIGINT,
    "created" TIMESTAMP(3) NOT NULL,
    "lastModified" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceTemplates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudienceTemplates_adAccountId_idx" ON "AudienceTemplates"("adAccountId");

-- AddForeignKey
ALTER TABLE "AudienceTemplates" ADD CONSTRAINT "AudienceTemplates_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
