package com.example.orders.controller;

import com.example.orders.model.OrderStatusResponse;
import com.example.orders.service.OrderService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/{orderId}/status")
    public ResponseEntity<OrderStatusResponse> getStatus(@PathVariable String orderId) {
        if (orderId == null || orderId.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        OrderStatusResponse response = orderService.queryStatus(orderId);
        return ResponseEntity.ok(response);
    }

    @PostMapping("/{orderId}/cancel")
    public ResponseEntity<Void> cancel(@PathVariable String orderId) {
        orderService.cancel(orderId);
        return ResponseEntity.noContent().build();
    }
}
