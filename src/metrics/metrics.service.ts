import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  Histogram,
  Counter,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: Registry;

  // Default metrics
  public readonly httpRequestDuration: Histogram;
  public readonly httpRequestTotal: Counter;
  public readonly httpRequestErrors: Counter;

  // Custom business metrics
  public readonly activeUsers: Gauge;

  constructor() {
    this.register = new Registry();

    // Set default labels for all metrics

    this.register.setDefaultLabels({
      app: 'nestjs-app',
      environment: process.env.NODE_ENV || 'development',
    });

    // Collect default Node.js metrics (CPU, memory, etc.)

    collectDefaultMetrics({ register: this.register });

    // HTTP request duration histogram
    // for tracking request latencies

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      registers: [this.register],
    });

    // HTTP request counter
    // for request rate per second

    this.httpRequestTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register],
    });

    // HTTP errors counter
    // for tracking HTTP request errors

    this.httpRequestErrors = new Counter({
      name: 'http_request_errors_total',
      help: 'Total number of HTTP request errors',
      labelNames: ['method', 'route', 'status_code', 'error_type'],
      registers: [this.register],
    });

    // Active users gauge

    this.activeUsers = new Gauge({
      name: 'active_users_total',
      help: 'Number of currently active users',
      registers: [this.register],
    });
  }

  onModuleInit() {
    console.log('Metrics service initialized');
  }

  // Get all metrics

  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  // Get metrics in JSON format

  async getMetricsJSON(): Promise<any> {
    return this.register.getMetricsAsJSON();
  }

  // Helper method to record HTTP request
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    duration: number,
  ) {
    this.httpRequestDuration.observe(
      { method, route, status_code: statusCode.toString() },
      duration,
    );

    this.httpRequestTotal.inc({
      method,
      route,
      status_code: statusCode.toString(),
    });
  }

  // Helper method to record HTTP error
  recordHttpError(
    method: string,
    route: string,
    statusCode: number,
    errorType: string,
  ) {
    this.httpRequestErrors.inc({
      method,
      route,
      status_code: statusCode.toString(),
      error_type: errorType,
    });
  }

  // Helper method to update active users
  setActiveUsers(count: number) {
    this.activeUsers.set(count);
  }
}
