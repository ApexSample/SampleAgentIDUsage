export class CheckoutMetrics {
  private requests = 0;
  private dependencyFailures = 0;
  private inventoryUp = 1;

  recordRequest(): void {
    this.requests += 1;
  }

  recordDependencyResult(up: boolean): void {
    this.inventoryUp = up ? 1 : 0;
    if (!up) this.dependencyFailures += 1;
  }

  render(): string {
    return [
      "# HELP sample_company_checkout_requests_total Checkout requests received.",
      "# TYPE sample_company_checkout_requests_total counter",
      `sample_company_checkout_requests_total ${this.requests}`,
      "# HELP sample_company_inventory_failures_total Failed calls from checkout to inventory.",
      "# TYPE sample_company_inventory_failures_total counter",
      `sample_company_inventory_failures_total ${this.dependencyFailures}`,
      "# HELP sample_company_inventory_up Whether checkout can reach inventory.",
      "# TYPE sample_company_inventory_up gauge",
      `sample_company_inventory_up ${this.inventoryUp}`,
      "",
    ].join("\n");
  }
}