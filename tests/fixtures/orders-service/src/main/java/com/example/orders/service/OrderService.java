package com.example.orders.service;

import com.example.orders.audit.StatusAuditor;
import com.example.orders.client.ShippingClient;
import com.example.orders.exception.OrderNotCancellableException;
import com.example.orders.exception.OrderNotFoundException;
import com.example.orders.exception.ShippingServiceException;
import com.example.orders.model.Order;
import com.example.orders.model.OrderStatusResponse;
import com.example.orders.model.ShippingInfo;
import com.example.orders.repository.OrderRepository;
import java.util.Optional;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final ShippingClient shippingClient;
    private final StatusAuditor auditor;

    public OrderService(OrderRepository orderRepository, ShippingClient shippingClient, StatusAuditor auditor) {
        this.orderRepository = orderRepository;
        this.shippingClient = shippingClient;
        this.auditor = auditor;
    }

    public OrderStatusResponse queryStatus(String orderId) {
        Optional<Order> found = orderRepository.findById(orderId);
        if (found.isEmpty()) {
            throw new OrderNotFoundException(orderId);
        }
        Order order = found.get();
        try {
            auditor.record(order);
        } catch (RuntimeException e) {
            System.err.println("auditoria fallida: " + e.getMessage());
        }
        if ("CANCELLED".equals(order.getStatus())) {
            return OrderStatusResponse.of(order, null);
        }
        ShippingInfo info = shippingClient.fetchShipping(orderId);
        if (info.getCode() != 0) {
            throw new ShippingServiceException("Codigo de envio no valido: " + info.getCode());
        }
        return OrderStatusResponse.of(order, info);
    }

    public void cancel(String orderId) {
        Order order = orderRepository.findById(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
        if ("SHIPPED".equals(order.getStatus())) {
            throw new OrderNotCancellableException(orderId);
        }
        order.setStatus("CANCELLED");
        orderRepository.save(order);
    }
}
