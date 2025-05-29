/*
  Warnings:

  - You are about to drop the column `adAccounts` on the `LinkedInPage` table. All the data in the column will be lost.
  - You are about to drop the column `campaignGroups` on the `LinkedInPage` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LinkedInPage" DROP COLUMN "adAccounts",
DROP COLUMN "campaignGroups";

-- CreateTable
CREATE TABLE "AdAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "linkedInPageId" TEXT NOT NULL,
    "accountUrn" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "userUrn" TEXT NOT NULL,
    "changeAuditStamps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignGroup" (
    "id" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "urn" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "runSchedule" JSONB,
    "test" BOOLEAN NOT NULL,
    "changeAuditStamps" JSONB NOT NULL,
    "totalBudget" JSONB,
    "servingStatuses" TEXT[],
    "backfilled" BOOLEAN NOT NULL,
    "accountUrn" TEXT NOT NULL,
    "objectiveType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_accountUrn_key" ON "AdAccount"("accountUrn");

-- CreateIndex
CREATE INDEX "AdAccount_linkedInPageId_idx" ON "AdAccount"("linkedInPageId");

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_organizationId_accountUrn_key" ON "AdAccount"("organizationId", "accountUrn");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignGroup_urn_key" ON "CampaignGroup"("urn");

-- CreateIndex
CREATE INDEX "CampaignGroup_adAccountId_idx" ON "CampaignGroup"("adAccountId");

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_linkedInPageId_fkey" FOREIGN KEY ("linkedInPageId") REFERENCES "LinkedInPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignGroup" ADD CONSTRAINT "CampaignGroup_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
