package com.example.orders.exception;

public class ShippingServiceException extends RuntimeException {
    public ShippingServiceException(String message) {
        super(message);
    }

    public ShippingServiceException(String message, Throwable cause) {
        super(message, cause);
    }
}
