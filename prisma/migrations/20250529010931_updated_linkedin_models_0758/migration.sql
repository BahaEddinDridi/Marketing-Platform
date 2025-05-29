/*
  Warnings:

  - The `format` column on the `MarketingCampaign` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "Format" AS ENUM ('CAROUSEL', 'FOLLOW_COMPANY', 'JOBS', 'SINGLE_VIDEO', 'SPONSORED_INMAIL', 'SPONSORED_MESSAGE', 'SPONSORED_UPDATE_EVENT', 'SPOTLIGHT', 'STANDARD_UPDATE', 'TEXT_AD', 'UNSUPPORTED');

-- AlterTable
ALTER TABLE "MarketingCampaign" DROP COLUMN "format",
ADD COLUMN     "format" "Format";
