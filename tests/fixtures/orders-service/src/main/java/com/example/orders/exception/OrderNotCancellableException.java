package com.example.orders.exception;

public class OrderNotCancellableException extends RuntimeException {
    public OrderNotCancellableException(String orderId) {
        super("Pedido no cancelable: " + orderId);
    }
}
