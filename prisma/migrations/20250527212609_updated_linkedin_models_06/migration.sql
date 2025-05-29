/*
  Warnings:

  - You are about to drop the column `accountUrn` on the `AdAccount` table. All the data in the column will be lost.
  - You are about to drop the column `externalId` on the `CampaignGroup` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[organizationId,id]` on the table `AdAccount` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "AdAccount_accountUrn_key";

-- DropIndex
DROP INDEX "AdAccount_organizationId_accountUrn_key";

-- DropIndex
DROP INDEX "CampaignGroup_externalId_key";

-- AlterTable
ALTER TABLE "AdAccount" DROP COLUMN "accountUrn";

-- AlterTable
ALTER TABLE "CampaignGroup" DROP COLUMN "externalId";

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_organizationId_id_key" ON "AdAccount"("organizationId", "id");
