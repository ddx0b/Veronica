export interface MetricsSnapshot {
  inboundEventsTotal: number;
  inboundDuplicatesTotal: number;
  inboundRejectedTotal: number;
  webhookValidationFailuresTotal: number;
  emailRequestsFailedTotal: number;
  whatsappSendFailuresTotal: number;
  deliveryRetriesTotal: number;
  deliveriesSubmittedTotal: number;
  deliveriesCompletedTotal: number;
  lastDeliveryLatencyMs: number | null;
  averageDeliveryLatencyMs: number | null;
}

export class MetricsRegistry {
  private inboundEventsTotal = 0;
  private inboundDuplicatesTotal = 0;
  private inboundRejectedTotal = 0;
  private webhookValidationFailuresTotal = 0;
  private emailRequestsFailedTotal = 0;
  private whatsappSendFailuresTotal = 0;
  private deliveryRetriesTotal = 0;
  private deliveriesSubmittedTotal = 0;
  private deliveriesCompletedTotal = 0;
  private lastDeliveryLatencyMs: number | null = null;
  private totalLatencyMs = 0;
  private latencySamples = 0;

  public incrementInboundEvents(): void {
    this.inboundEventsTotal += 1;
  }

  public incrementInboundDuplicates(): void {
    this.inboundDuplicatesTotal += 1;
  }

  public incrementInboundRejected(): void {
    this.inboundRejectedTotal += 1;
  }

  public incrementWebhookValidationFailures(): void {
    this.webhookValidationFailuresTotal += 1;
  }

  public incrementEmailRequestFailures(): void {
    this.emailRequestsFailedTotal += 1;
  }

  public incrementWhatsappSendFailures(): void {
    this.whatsappSendFailuresTotal += 1;
  }

  public incrementDeliveryRetries(): void {
    this.deliveryRetriesTotal += 1;
  }

  public incrementDeliveriesSubmitted(): void {
    this.deliveriesSubmittedTotal += 1;
  }

  public incrementDeliveriesCompleted(): void {
    this.deliveriesCompletedTotal += 1;
  }

  public recordDeliveryLatency(latencyMs: number): void {
    const safeMs = Math.max(0, Math.round(latencyMs));
    this.lastDeliveryLatencyMs = safeMs;
    this.totalLatencyMs += safeMs;
    this.latencySamples += 1;
  }

  public snapshot(): MetricsSnapshot {
    return {
      inboundEventsTotal: this.inboundEventsTotal,
      inboundDuplicatesTotal: this.inboundDuplicatesTotal,
      inboundRejectedTotal: this.inboundRejectedTotal,
      webhookValidationFailuresTotal: this.webhookValidationFailuresTotal,
      emailRequestsFailedTotal: this.emailRequestsFailedTotal,
      whatsappSendFailuresTotal: this.whatsappSendFailuresTotal,
      deliveryRetriesTotal: this.deliveryRetriesTotal,
      deliveriesSubmittedTotal: this.deliveriesSubmittedTotal,
      deliveriesCompletedTotal: this.deliveriesCompletedTotal,
      lastDeliveryLatencyMs: this.lastDeliveryLatencyMs,
      averageDeliveryLatencyMs:
        this.latencySamples > 0 ? Math.round(this.totalLatencyMs / this.latencySamples) : null,
    };
  }
}
