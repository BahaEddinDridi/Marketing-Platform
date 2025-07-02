/*
  Warnings:

  - A unique constraint covering the columns `[adId,datePeriodStart,datePeriodEnd,timeGranularity]` on the table `AdAnalytics` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "AdAnalytics_adId_datePeriodStart_datePeriodEnd_timeGranular_key" ON "AdAnalytics"("adId", "datePeriodStart", "datePeriodEnd", "timeGranularity");
