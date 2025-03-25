import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QUERIES, handleMqttMessage } from "./worker.js";

// Create mock functions
const mockOn = mock((event, callback) => {
  return mockMqttClient;
});

const mockSubscribe = mock(() => {});
const mockEnd = mock(() => {});

// Mock MQTT client
const mockMqttClient = {
  on: mockOn,
  subscribe: mockSubscribe,
  end: mockEnd,
};

// Mock Resend client
const mockSendEmail = mock(() => Promise.resolve({ id: "test-email-id" }));
mock.module("resend", () => ({
  Resend: class MockResend {
    constructor() {
      this.emails = {
        send: mockSendEmail,
      };
    }
  },
}));

// Mock connect function
mock.module("mqtt", () => ({
  connect: () => mockMqttClient,
}));

// Import the worker after mocking dependencies
const worker = require("./worker.js").default;

describe("Notification Worker", () => {
  const mockDbAll = mock(async () => [{ id: "test-alert-id" }]);
  const mockDbRun = mock(async () => ({ success: true }));
  const mockDbBind = mock(() => ({
    all: mockDbAll,
    run: mockDbRun,
  }));
  const mockDbPrepare = mock(() => ({
    bind: mockDbBind,
  }));

  const mockEnv = {
    DB: {
      prepare: mockDbPrepare,
    },
    MQTT_USERNAME: "test-user",
    MQTT_PASSWORD: "test-pass",
    RESEND_API_KEY: "test-key",
  };

  const mockCtx = {
    waitUntil: mock((promise) => promise),
  };

  beforeEach(() => {
    // Reset all mocks before each test
    mockOn.mockReset();
    mockSubscribe.mockReset();
    mockEnd.mockReset();
    mockDbPrepare.mockReset();
    mockDbBind.mockReset();
    mockDbAll.mockReset();
    mockDbRun.mockReset();
    mockSendEmail.mockReset();
  });

  describe("HTTP Handler", () => {
    test("GET request returns health check response", async () => {
      const request = new Request("http://localhost", {
        method: "GET",
      });
      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Notification Worker Running");
    });

    test("POST request with invalid content type returns 415", async () => {
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: "test",
      });
      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(415);
      expect(await response.text()).toBe(
        "Content-Type must be application/json"
      );
    });

    test("POST request with valid notification returns success response", async () => {
      // Set up mock database responses
      const mockUserInfoBind = mock(() => ({
        all: async () => [
          { user_id: "test-user-id", email: "test@example.com" },
        ],
      }));

      const mockInsertBind = mock(() => ({
        all: async () => [{ id: "test-alert-id" }],
      }));

      const mockUpdateBind = mock(() => ({
        run: async () => ({ success: true }),
      }));

      const mockUserInfoStmt = {
        bind: mockUserInfoBind,
      };

      const mockInsertStmt = {
        bind: mockInsertBind,
      };

      const mockUpdateStmt = {
        bind: mockUpdateBind,
      };

      mockDbPrepare
        .mockImplementationOnce(() => mockUserInfoStmt) // For getUserInfo
        .mockImplementationOnce(() => mockInsertStmt) // For insertAlert
        .mockImplementationOnce(() => mockUpdateStmt); // For updateAlertStatus

      const testMessage = {
        home_id: "test-home",
        device_id: "test-device",
        message: "Test alert message",
      };

      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testMessage),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      const responseData = await response.json();

      expect(response.status).toBe(200);
      expect(responseData).toEqual({
        success: true,
        alert_id: "test-alert-id",
      });

      // Verify database operations
      expect(mockDbPrepare).toHaveBeenCalledTimes(3);
      expect(mockDbPrepare).toHaveBeenNthCalledWith(1, QUERIES.getUserInfo);
      expect(mockDbPrepare).toHaveBeenNthCalledWith(2, QUERIES.insertAlert);
      expect(mockDbPrepare).toHaveBeenNthCalledWith(
        3,
        QUERIES.updateAlertStatus
      );

      // Verify bind calls
      expect(mockUserInfoBind).toHaveBeenCalledWith("test-home");
      expect(mockInsertBind).toHaveBeenCalledWith(
        "test-home",
        "test-user-id",
        "test-device",
        "Test alert message"
      );
      expect(mockUpdateBind).toHaveBeenCalledWith("test-alert-id");

      // Verify email was sent
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith({
        from: "Smart Home Alert <alerts@smart-home-alert.com>",
        to: "test@example.com",
        subject: "Smart Home Alert",
        text: "Test alert message",
      });
    });

    test("POST request with invalid notification returns error response", async () => {
      const invalidMessage = {
        home_id: "test-home",
        // Missing required fields
      };

      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidMessage),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData).toEqual({
        success: false,
        error: "Invalid message payload: missing required fields",
      });

      // Verify no database operations were performed
      expect(mockDbPrepare).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test("Unsupported HTTP method returns 405", async () => {
      const request = new Request("http://localhost", {
        method: "PUT",
      });
      const response = await worker.fetch(request, mockEnv, mockCtx);

      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });
  });

  describe("MQTT Handler", () => {
    test("scheduled handler sets up MQTT client correctly", async () => {
      // Create a promise to control the connect callback
      let connectResolve;
      const connectPromise = new Promise((resolve) => {
        connectResolve = resolve;
      });

      // Store callbacks
      const callbacks = {};

      mockOn.mockImplementation((event, callback) => {
        callbacks[event] = callback;
        if (event === "connect") {
          setTimeout(() => {
            callback();
            connectResolve();
          }, 0);
        }
        return mockMqttClient;
      });

      // Start the scheduled handler but don't wait for it to complete
      const scheduledPromise = worker.scheduled({}, mockEnv, mockCtx);

      // Wait for the connect callback to be called
      await connectPromise;

      // Verify MQTT client setup
      expect(mockOn).toHaveBeenCalledTimes(3); // connect, error, and message handlers
      expect(mockSubscribe).toHaveBeenCalledWith("/notification");
      expect(callbacks.connect).toBeDefined();
      expect(callbacks.message).toBeDefined();
      expect(callbacks.error).toBeDefined();

      // End the client to stop the scheduled handler
      mockMqttClient.end();
    });

    test("handleMqttMessage processes valid message correctly", async () => {
      // Set up mock database responses
      const mockUserInfoBind = mock(() => ({
        all: async () => [
          { user_id: "test-user-id", email: "test@example.com" },
        ],
      }));

      const mockInsertBind = mock(() => ({
        all: async () => [{ id: "test-alert-id" }],
      }));

      const mockUpdateBind = mock(() => ({
        run: async () => ({ success: true }),
      }));

      const mockUserInfoStmt = {
        bind: mockUserInfoBind,
      };

      const mockInsertStmt = {
        bind: mockInsertBind,
      };

      const mockUpdateStmt = {
        bind: mockUpdateBind,
      };

      mockDbPrepare
        .mockImplementationOnce(() => mockUserInfoStmt) // For getUserInfo
        .mockImplementationOnce(() => mockInsertStmt) // For insertAlert
        .mockImplementationOnce(() => mockUpdateStmt); // For updateAlertStatus

      const testMessage = {
        home_id: "test-home",
        device_id: "test-device",
        message: "Test alert message",
      };

      const alertId = await handleMqttMessage(
        "/notification",
        Buffer.from(JSON.stringify(testMessage)),
        mockEnv.DB,
        mockEnv.RESEND_API_KEY
      );

      expect(alertId).toBe("test-alert-id");

      // Verify database operations
      expect(mockDbPrepare).toHaveBeenCalledTimes(3);
      expect(mockDbPrepare).toHaveBeenNthCalledWith(1, QUERIES.getUserInfo);
      expect(mockDbPrepare).toHaveBeenNthCalledWith(2, QUERIES.insertAlert);
      expect(mockDbPrepare).toHaveBeenNthCalledWith(
        3,
        QUERIES.updateAlertStatus
      );

      // Verify bind calls
      expect(mockUserInfoBind).toHaveBeenCalledWith("test-home");
      expect(mockInsertBind).toHaveBeenCalledWith(
        "test-home",
        "test-user-id",
        "test-device",
        "Test alert message"
      );
      expect(mockUpdateBind).toHaveBeenCalledWith("test-alert-id");

      // Verify email was sent
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith({
        from: "Smart Home Alert <alerts@smart-home-alert.com>",
        to: "test@example.com",
        subject: "Smart Home Alert",
        text: "Test alert message",
      });
    });

    test("handleMqttMessage handles invalid message gracefully", async () => {
      const invalidMessage = {
        home_id: "test-home",
        // Missing required fields
      };

      await handleMqttMessage(
        "/notification",
        Buffer.from(JSON.stringify(invalidMessage)),
        mockEnv.DB,
        mockEnv.RESEND_API_KEY
      );

      // Verify no database operations were performed
      expect(mockDbPrepare).not.toHaveBeenCalled();
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    test("MQTT client handles connection errors", async () => {
      // Create a promise to control the error callback
      let errorResolve;
      const errorPromise = new Promise((resolve) => {
        errorResolve = resolve;
      });

      mockOn.mockImplementation((event, callback) => {
        if (event === "error") {
          setTimeout(() => {
            callback(new Error("Test MQTT error"));
            errorResolve();
          }, 0);
        }
        return mockMqttClient;
      });

      // The scheduled function should throw the error
      await expect(worker.scheduled({}, mockEnv, mockCtx)).rejects.toThrow(
        "Test MQTT error"
      );
      await errorPromise;

      // Verify client is closed on error
      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
