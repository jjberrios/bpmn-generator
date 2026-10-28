package com.example.orders.audit;

import com.example.orders.model.Order;
import org.springframework.stereotype.Component;

@Component
public class LogStatusAuditor implements StatusAuditor {
    @Override
    public void record(Order order) {
        System.out.println("order " + order.getId());
    }
}
