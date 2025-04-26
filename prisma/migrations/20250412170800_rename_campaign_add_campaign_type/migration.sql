/*
  Warnings:

  - The primary key for the `Campaign` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `budget` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `campaign_id` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `campaign_name` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `end_date` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `platform_id` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `start_date` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Campaign` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[name,platform]` on the table `Campaign` will be added. If there are existing duplicate values, this will fail.
  - The required column `id` was added to the `Campaign` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `name` to the `Campaign` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform` to the `Campaign` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_platform_id_fkey";

-- DropForeignKey
ALTER TABLE "CampaignPerformance" DROP CONSTRAINT "CampaignPerformance_campaign_id_fkey";

-- AlterTable
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_pkey",
DROP COLUMN "budget",
DROP COLUMN "campaign_id",
DROP COLUMN "campaign_name",
DROP COLUMN "end_date",
DROP COLUMN "platform_id",
DROP COLUMN "start_date",
DROP COLUMN "status",
ADD COLUMN     "description" TEXT,
ADD COLUMN     "id" TEXT NOT NULL,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "platform" TEXT NOT NULL,
ADD CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "platform_id" TEXT,
    "budget" DOUBLE PRECISION NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "status" "CampaignStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_name_platform_key" ON "Campaign"("name", "platform");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "MarketingPlatform"("platform_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPerformance" ADD CONSTRAINT "CampaignPerformance_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "MarketingCampaign"("campaign_id") ON DELETE RESTRICT ON UPDATE CASCADE;
