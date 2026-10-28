package com.example.orders.audit;

import com.example.orders.model.Order;
import org.springframework.stereotype.Component;

@Component
public class MemoryStatusAuditor implements StatusAuditor {
    @Override
    public void record(Order order) {
        // implementacion alternativa en memoria
    }
}
