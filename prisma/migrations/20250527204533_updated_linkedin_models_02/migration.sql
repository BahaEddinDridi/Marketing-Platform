/*
  Warnings:

  - A unique constraint covering the columns `[externalId]` on the table `CampaignGroup` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "CampaignGroup" ADD COLUMN     "externalId" TEXT,
ALTER COLUMN "urn" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CampaignGroup_externalId_key" ON "CampaignGroup"("externalId");
