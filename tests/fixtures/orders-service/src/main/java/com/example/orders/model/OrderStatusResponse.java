package com.example.orders.model;

public class OrderStatusResponse {
    private String orderId;
    private String status;
    private String carrier;

    public static OrderStatusResponse of(Order order, ShippingInfo info) {
        OrderStatusResponse r = new OrderStatusResponse();
        r.orderId = order.getId();
        r.status = order.getStatus();
        r.carrier = info == null ? null : info.getCarrier();
        return r;
    }

    public String getOrderId() { return orderId; }
    public String getStatus() { return status; }
    public String getCarrier() { return carrier; }
}
