/*
  Warnings:

  - The primary key for the `Lead` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `Lead` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `email` to the `Lead` table without a default value. This is not possible if the table is not empty.
  - The required column `lead_id` was added to the `Lead` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `source_platform` to the `Lead` table without a default value. This is not possible if the table is not empty.
  - Added the required column `status` to the `Lead` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `Lead` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Lead_phone_key";

-- AlterTable
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_pkey",
DROP COLUMN "id",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "email" TEXT NOT NULL,
ADD COLUMN     "job_title" TEXT,
ADD COLUMN     "lead_id" TEXT NOT NULL,
ADD COLUMN     "source_platform" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "phone" DROP NOT NULL,
ALTER COLUMN "phone" SET DATA TYPE TEXT,
ALTER COLUMN "company" DROP NOT NULL,
ADD CONSTRAINT "Lead_pkey" PRIMARY KEY ("lead_id");

-- CreateTable
CREATE TABLE "User" (
    "user_id" TEXT NOT NULL,
    "firstname" TEXT NOT NULL,
    "lastname" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "MarketingPlatform" (
    "platform_id" TEXT NOT NULL,
    "platform_name" TEXT NOT NULL,
    "last_sync_time" TIMESTAMP(3),
    "sync_status" TEXT NOT NULL,

    CONSTRAINT "MarketingPlatform_pkey" PRIMARY KEY ("platform_id")
);

-- CreateTable
CREATE TABLE "PlatformCredentials" (
    "credential_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "token_expiry" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCredentials_pkey" PRIMARY KEY ("credential_id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "budget" DOUBLE PRECISION NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "CampaignPerformance" (
    "performance_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "conversions" INTEGER NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "roi" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignPerformance_pkey" PRIMARY KEY ("performance_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingPlatform_platform_name_key" ON "MarketingPlatform"("platform_name");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_email_key" ON "Lead"("email");

-- AddForeignKey
ALTER TABLE "PlatformCredentials" ADD CONSTRAINT "PlatformCredentials_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "MarketingPlatform"("platform_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "MarketingPlatform"("platform_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPerformance" ADD CONSTRAINT "CampaignPerformance_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign"("campaign_id") ON DELETE RESTRICT ON UPDATE CASCADE;
